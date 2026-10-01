import type { AgentDecision, ProjectEdit } from '../domain/agent-action';
import { hasMistakesLeft } from '../domain/agent-policy';
import type { AgentTurn, CompileDiagnostic, ToolResult } from '../domain/agent-transcript';
import {
  ProposalStatus,
  type ConversationMessage,
  type ProposalMessage,
  type ReplyMessage,
  type SystemRequestMessage,
  type UserMessage,
} from '../domain/conversation';
import type { AgentPort, AgentRequest, AgentWorkspace, ContextUsage } from '../ports/agent-port';
import type { CancellationController, CancellationSignal } from '../ports/cancellation';
import type { EditorPort } from '../ports/editor-port';
import type { ProjectPort } from '../ports/project-port';
import {
  acceptDecision,
  isAgentMistake,
  type AcceptedDecision,
  type AgentMistake,
} from './agent-decision';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import { AgentMistakeLimitError, EmptyRequestError } from './errors';
import type { OperationLock } from './operation-lock';
import { PendingDocumentChange, type PendingChanges } from './pending-change';
import { ProjectTools } from './project-tools';
import { showProjectFile } from './show-project-file';

export type { ContextUsage } from '../ports/agent-port';

interface RequestRun {
  readonly epoch: number;
  readonly signal: CancellationSignal;
  readonly onProgress: (progress: AgentProgress) => void;
}

export const COMPILE_FIX_REQUEST =
  'Compiling the project after the applied change reports errors; fix the first error.';

export type AgentResult =
  | {
      readonly kind: 'reply';
      readonly message: ReplyMessage;
      readonly contextUsage: ContextUsage;
    }
  | {
      readonly kind: 'proposal';
      readonly message: ProposalMessage;
      readonly changeId: string;
      readonly contextUsage: ContextUsage;
    };

export class HandleAssistantRequest {
  private readonly tools: ProjectTools;

  constructor(
    private readonly deps: {
      agent: AgentPort;
      project: ProjectPort;
      editor: EditorPort;
      conversation: ConversationLog;
      pendingChanges: PendingChanges;
      lock: OperationLock;
      newId: () => string;
      createController: () => CancellationController;
    },
  ) {
    this.tools = new ProjectTools(deps.project, deps.createController);
  }

  getUnusedContext(): ContextUsage {
    return { contextTokens: this.deps.agent.contextTokens, promptTokens: 0 };
  }

  async execute(text: string, onProgress: (progress: AgentProgress) => void): Promise<AgentResult> {
    const request = text.trim();
    if (!request) throw new EmptyRequestError();
    return await this.deps.lock.run(async (signal) => {
      const message: UserMessage = { id: this.deps.newId(), role: 'user', text: request };
      const { history, epoch } = this.receive(message, onProgress);
      return await this.runAgent({ kind: 'user', message }, history, { epoch, signal, onProgress });
    });
  }

  async fixCompileErrors(
    diagnostics: readonly CompileDiagnostic[],
    onProgress: (progress: AgentProgress) => void,
    signal: CancellationSignal,
  ): Promise<AgentResult> {
    this.deps.lock.assertHeld();
    const message: SystemRequestMessage = {
      id: this.deps.newId(),
      role: 'system',
      text: COMPILE_FIX_REQUEST,
    };
    const { history, epoch } = this.receive(message, onProgress);
    return await this.runAgent({ kind: 'compile-fix', message, diagnostics }, history, {
      epoch,
      signal,
      onProgress,
    });
  }

  private receive(
    message: UserMessage | SystemRequestMessage,
    onProgress: (progress: AgentProgress) => void,
  ): { history: readonly ConversationMessage[]; epoch: number } {
    const { editor, conversation, pendingChanges } = this.deps;
    const discarded = pendingChanges.discardAll();
    if (discarded.length) editor.clearPreview();
    for (const proposal of discarded) onProgress({ stage: 'decided', message: proposal });
    const history = conversation.messages();
    const epoch = conversation.epoch;
    conversation.append(message);
    onProgress({ stage: 'received', message });
    return { history, epoch };
  }

  private async runAgent(
    request: AgentRequest,
    history: readonly ConversationMessage[],
    run: RequestRun,
  ): Promise<AgentResult> {
    const { agent, conversation } = this.deps;
    const { epoch, signal, onProgress } = run;
    const workspace = await this.readWorkspace(signal);
    conversation.ensureCurrent(epoch);
    const transcript: AgentTurn[] = [];
    for (let step = 1; ; step += 1) {
      onProgress({ stage: 'thinking', step });
      const { decision, contextUsage } = await agent.decide({
        request,
        conversation: history,
        workspace,
        transcript: [...transcript],
        signal,
      });
      conversation.ensureCurrent(epoch);
      let accepted: AcceptedDecision;
      try {
        accepted = acceptDecision(decision, workspace, transcript);
      } catch (error) {
        if (!isAgentMistake(error)) throw error;
        recordMistake(transcript, decision, error);
        continue;
      }
      if (accepted.kind !== 'tool') {
        return await this.answer(accepted, contextUsage, run);
      }
      let result: ToolResult;
      try {
        result = await this.tools.run(accepted.run, onProgress, signal);
      } catch (error) {
        if (!isAgentMistake(error)) throw error;
        recordMistake(transcript, decision, error);
        continue;
      }
      conversation.ensureCurrent(epoch);
      transcript.push({ kind: 'tool', call: accepted.call, result });
    }
  }

  private async readWorkspace(signal: CancellationSignal): Promise<AgentWorkspace> {
    const { project, editor } = this.deps;
    const files = project.listFiles();
    const shown = project.shownFile();
    await project.openFile(shown, signal);
    return {
      files,
      openFile: { path: shown.path, document: editor.readDocument(shown) },
      cursorLine: editor.readCursorLine(shown),
      selection: editor.readSelection(shown),
    };
  }

  private async answer(
    reply: Exclude<AcceptedDecision, { readonly kind: 'tool' }>,
    contextUsage: ContextUsage,
    { epoch, signal, onProgress }: RequestRun,
  ): Promise<AgentResult> {
    switch (reply.kind) {
      case 'answer':
        return { kind: 'reply', message: this.reply('explanation', reply.text), contextUsage };
      case 'question':
        return { kind: 'reply', message: this.reply('clarification', reply.text), contextUsage };
      case 'edit': {
        await showProjectFile(this.deps.project, reply.change.file, onProgress, signal);
        this.deps.conversation.ensureCurrent(epoch);
        const message = this.propose(reply.change);
        return { kind: 'proposal', message, changeId: message.id, contextUsage };
      }
    }
  }

  private propose(change: ProjectEdit): ProposalMessage {
    const { editor, conversation, pendingChanges } = this.deps;
    const { file, edit } = change;
    edit.assertCurrent(editor.readDocument(file));
    editor.showPreview(file, edit);
    const message: ProposalMessage = {
      id: this.deps.newId(),
      role: 'assistant',
      kind: 'proposal',
      path: file.path,
      command: edit.command,
      status: ProposalStatus.Proposed,
    };
    conversation.append(message);
    pendingChanges.add(new PendingDocumentChange(message.id, change));
    return message;
  }

  private reply(kind: ReplyMessage['kind'], text: string): ReplyMessage {
    const message: ReplyMessage = { id: this.deps.newId(), role: 'assistant', kind, text };
    this.deps.conversation.append(message);
    return message;
  }
}

function recordMistake(
  transcript: AgentTurn[],
  decision: AgentDecision,
  mistake: AgentMistake,
): void {
  transcript.push({ kind: 'mistake', decision, problem: mistake.message });
  if (!hasMistakesLeft(transcript)) throw new AgentMistakeLimitError(mistake);
}
