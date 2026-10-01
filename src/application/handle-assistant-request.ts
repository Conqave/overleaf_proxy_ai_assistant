import type { ProjectEdit } from '../domain/agent-action';
import { hasMistakesLeft } from '../domain/agent-policy';
import type { AgentTurn } from '../domain/agent-transcript';
import type {
  AssistantMessage,
  GreetingMessage,
  ProposalMessage,
  ReplyMessage,
  UserMessage,
} from '../domain/conversation';
import type { AgentPort, AgentWorkspace, ContextUsage } from '../ports/agent-port';
import type { EditorPort } from '../ports/editor-port';
import type { ProjectPort } from '../ports/project-port';
import { acceptDecision, isAgentMistake, type AcceptedDecision } from './agent-decision';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import {
  AgentMistakeLimitError,
  EmptyRequestError,
  RequestInProgressError,
  RequestSupersededError,
} from './errors';
import { isGreetingOnly } from './greeting-policy';
import { PendingDocumentChange, type PendingChanges } from './pending-change';
import { ProjectTools } from './project-tools';
import { showProjectFile } from './show-project-file';

export interface AssistantRequestResult {
  readonly message: AssistantMessage;
  readonly changeId?: string;
  readonly contextUsage?: ContextUsage;
}

export class HandleAssistantRequest {
  private running = false;
  private readonly tools: ProjectTools;

  constructor(
    private readonly deps: {
      agent: AgentPort;
      project: ProjectPort;
      editor: EditorPort;
      conversation: ConversationLog;
      pendingChanges: PendingChanges;
      newId: () => string;
    },
  ) {
    this.tools = new ProjectTools(deps.project);
  }

  async execute(
    text: string,
    onProgress: (progress: AgentProgress) => void,
    initialTranscript: readonly AgentTurn[] = [],
  ): Promise<AssistantRequestResult> {
    if (this.running) throw new RequestInProgressError();
    this.running = true;
    try {
      return await this.run(text, onProgress, initialTranscript);
    } finally {
      this.running = false;
    }
  }

  private async run(
    text: string,
    onProgress: (progress: AgentProgress) => void,
    initialTranscript: readonly AgentTurn[],
  ): Promise<AssistantRequestResult> {
    const { agent, editor, conversation, pendingChanges } = this.deps;
    const request = text.trim();
    if (!request) throw new EmptyRequestError();

    if (pendingChanges.discardAll().length) editor.clearPreview();
    const history = conversation.messages();
    const epoch = conversation.epoch;
    const userMessage: UserMessage = { id: this.deps.newId(), role: 'user', text: request };
    conversation.append(userMessage);
    onProgress({ stage: 'received', message: userMessage });

    if (isGreetingOnly(request)) {
      return { message: this.greet() };
    }

    const workspace = this.readWorkspace();
    const transcript: AgentTurn[] = [...initialTranscript];
    for (let step = 1; ; step += 1) {
      onProgress({ stage: 'thinking', step });
      const { decision, contextUsage } = await agent.decide({
        message: request,
        conversation: history,
        workspace,
        transcript: [...transcript],
      });
      this.ensureCurrent(epoch);
      let accepted: AcceptedDecision;
      try {
        accepted = acceptDecision(decision, workspace, transcript);
      } catch (error) {
        if (!isAgentMistake(error)) throw error;
        transcript.push({ kind: 'mistake', decision, problem: error.message });
        if (!hasMistakesLeft(transcript)) throw new AgentMistakeLimitError(error);
        continue;
      }
      if (accepted.kind !== 'tool') {
        return { ...(await this.answer(accepted, epoch, onProgress)), contextUsage };
      }
      const result = await this.tools.run(accepted.run, onProgress);
      this.ensureCurrent(epoch);
      transcript.push({ kind: 'tool', call: accepted.call, result });
    }
  }

  private readWorkspace(): AgentWorkspace {
    const { project, editor } = this.deps;
    return {
      files: project.listFiles(),
      openFile: { path: project.openFilePath(), document: editor.readDocument() },
      cursorLine: editor.readCursorLine(),
      selection: editor.readSelection(),
    };
  }

  private async answer(
    reply: Exclude<AcceptedDecision, { readonly kind: 'tool' }>,
    epoch: number,
    onProgress: (progress: AgentProgress) => void,
  ): Promise<AssistantRequestResult> {
    switch (reply.kind) {
      case 'answer':
        return { message: this.reply('explanation', reply.text) };
      case 'question':
        return { message: this.reply('clarification', reply.text) };
      case 'edit':
        await showProjectFile(this.deps.project, reply.change.file, onProgress);
        this.ensureCurrent(epoch);
        return this.propose(reply.change);
    }
  }

  private ensureCurrent(epoch: number): void {
    if (this.deps.conversation.epoch !== epoch) throw new RequestSupersededError();
  }

  private propose(edit: ProjectEdit): AssistantRequestResult {
    const change = new PendingDocumentChange(this.deps.newId(), edit);
    this.deps.pendingChanges.add(change);
    this.showPreview(change);
    const message: ProposalMessage = {
      id: change.id,
      role: 'assistant',
      kind: 'proposal',
      path: edit.file.path,
      command: edit.edit.command,
    };
    this.deps.conversation.append(message);
    return { message, changeId: change.id };
  }

  private showPreview(change: PendingDocumentChange): void {
    const { editor } = this.deps;
    const { edit } = change.change;
    try {
      edit.assertCurrent(editor.readDocument());
      editor.showPreview(edit);
    } catch (error) {
      change.discard();
      editor.clearPreview();
      throw error;
    }
    change.markPreviewed();
  }

  private greet(): GreetingMessage {
    const message: GreetingMessage = { id: this.deps.newId(), role: 'assistant', kind: 'greeting' };
    this.deps.conversation.append(message);
    return message;
  }

  private reply(kind: ReplyMessage['kind'], text: string): ReplyMessage {
    const message: ReplyMessage = { id: this.deps.newId(), role: 'assistant', kind, text };
    this.deps.conversation.append(message);
    return message;
  }
}
