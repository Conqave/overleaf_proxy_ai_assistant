import {
  AgentTool,
  type AgentReply,
  type ProjectEdit,
  type ToolCall,
} from '../domain/agent-action';
import { checkToolCall } from '../domain/agent-policy';
import type { AgentTurn, ToolResult } from '../domain/agent-transcript';
import type {
  AssistantMessage,
  GreetingMessage,
  ProposalMessage,
  ReplyMessage,
  UserMessage,
} from '../domain/conversation';
import { findTextFile, listTextFiles } from '../domain/project-file';
import { searchProject } from '../domain/project-search';
import type { AgentPort, AgentWorkspace, ContextUsage } from '../ports/agent-port';
import type { EditorPort } from '../ports/editor-port';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import { EmptyRequestError, RequestInProgressError, RequestSupersededError } from './errors';
import { isGreetingOnly } from './greeting-policy';
import { PendingDocumentChange, type PendingChanges } from './pending-change';
import { showProjectFile } from './show-project-file';

export interface AssistantRequestResult {
  readonly message: AssistantMessage;
  readonly changeId?: string;
  readonly contextUsage?: ContextUsage;
}

export class HandleAssistantRequest {
  private running = false;

  constructor(
    private readonly deps: {
      agent: AgentPort;
      project: ProjectPort;
      editor: EditorPort;
      conversation: ConversationLog;
      pendingChanges: PendingChanges;
      newId: () => string;
    },
  ) {}

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
      if (decision.kind === 'reply') {
        return { ...(await this.answer(decision.reply, epoch, onProgress)), contextUsage };
      }
      checkToolCall(transcript, decision.call);
      const result = await this.callTool(decision.call, workspace, onProgress);
      this.ensureCurrent(epoch);
      transcript.push({ call: decision.call, result });
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

  private async callTool(
    call: ToolCall,
    workspace: AgentWorkspace,
    onProgress: (progress: AgentProgress) => void,
  ): Promise<ToolResult> {
    const { project } = this.deps;
    switch (call.tool) {
      case AgentTool.ReadFile: {
        const file = findTextFile(workspace.files, call.path);
        onProgress({ stage: 'reading', path: call.path });
        return { tool: call.tool, path: call.path, document: await project.readFile(file) };
      }
      case AgentTool.Search: {
        onProgress({ stage: 'searching', query: call.query });
        const searched = await Promise.all(
          listTextFiles(workspace.files).map(async (file) => ({
            path: file.path,
            document: await project.readFile(file),
          })),
        );
        return { tool: call.tool, ...searchProject(searched, call.query) };
      }
      case AgentTool.Compile:
        onProgress({ stage: 'compiling' });
        return { tool: call.tool, diagnostics: await project.compile() };
    }
  }

  private async answer(
    reply: AgentReply,
    epoch: number,
    onProgress: (progress: AgentProgress) => void,
  ): Promise<AssistantRequestResult> {
    switch (reply.kind) {
      case 'answer':
        return { message: this.reply('explanation', reply.text) };
      case 'question':
        return { message: this.reply('clarification', reply.text) };
      case 'edit':
        await showProjectFile(this.deps.project, reply.change.path, onProgress);
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
      path: edit.path,
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
