import type { AgentDecision, ProjectEdit } from '../domain/agent-action';
import { hasMistakesLeft } from '../domain/agent-policy';
import {
  recordToolTurn,
  type AgentTurn,
  type CompileDiagnostic,
  type ToolResult,
  type ToolTurn,
} from '../domain/agent-transcript';
import {
  ProposalStatus,
  type ProposalMessage,
  type ToolMessage,
  type ReplyMessage,
  type SystemRequestMessage,
  type UserMessage,
} from '../domain/conversation';
import { viewConversation, type ConversationView } from '../domain/conversation-view';
import type {
  AgentPort,
  AgentRequest,
  AgentStep,
  AgentStepRequest,
  AgentWorkspace,
  ContextUsage,
} from '../ports/agent-port';
import type { CancellationController, CancellationSignal } from '../ports/cancellation';
import { AssistantContextOverflowError } from '../ports/errors';
import type { EditorPort } from '../ports/editor-port';
import type { ProjectPort } from '../ports/project-port';
import {
  acceptDecision,
  isAgentMistake,
  type AcceptedDecision,
  type AgentMistake,
} from './agent-decision';
import type { AgentProgress } from './agent-progress';
import type { ConversationCompactor } from './conversation-compactor';
import type { ConversationLog } from './conversation-log';
import { AgentMistakeLimitError, EmptyRequestError } from './errors';
import type { OperationLock } from './operation-lock';
import { PendingDocumentChange, type PendingChanges } from './pending-change';
import { ProjectTools } from './project-tools';
import { showProjectFile } from './show-project-file';

export type { ContextPressure, ContextUsage } from '../ports/agent-port';

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
      compactor: ConversationCompactor;
    },
  ) {
    this.tools = new ProjectTools(deps.project, deps.createController);
  }

  getUnusedContext(): ContextUsage {
    return this.deps.agent.idleUsage;
  }

  async execute(text: string, onProgress: (progress: AgentProgress) => void): Promise<AgentResult> {
    const request = text.trim();
    if (!request) throw new EmptyRequestError();
    return await this.deps.lock.run(async (signal) => {
      const message: UserMessage = { id: this.deps.newId(), role: 'user', text: request };
      const epoch = this.receive(message, onProgress);
      return await this.runAgent({ kind: 'user', message }, { epoch, signal, onProgress });
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
    const epoch = this.receive(message, onProgress);
    return await this.runAgent(
      { kind: 'compile-fix', message, diagnostics },
      { epoch, signal, onProgress },
    );
  }

  private receive(
    message: UserMessage | SystemRequestMessage,
    onProgress: (progress: AgentProgress) => void,
  ): number {
    const { editor, conversation, pendingChanges } = this.deps;
    const discarded = pendingChanges.discardAll();
    if (discarded.length) editor.clearPreview();
    for (const proposal of discarded) onProgress({ stage: 'decided', message: proposal });
    const epoch = conversation.epoch;
    conversation.append(message);
    onProgress({ stage: 'received', message });
    return epoch;
  }

  private async runAgent(request: AgentRequest, run: RequestRun): Promise<AgentResult> {
    const { conversation, compactor } = this.deps;
    const { epoch, signal, onProgress } = run;
    const workspace = await this.readWorkspace(signal);
    conversation.ensureCurrent(epoch);
    const transcript: AgentTurn[] = [];
    const turnIds = new Set([request.message.id]);
    const stepRequest = (): AgentStepRequest => ({
      request,
      conversation: this.viewHistory(turnIds),
      workspace,
      transcript: [...transcript],
      signal,
    });
    let isCompacted = false;
    for (let step = 1; ; step += 1) {
      if (!isCompacted) {
        const summary = await compactor.compact(
          { kind: 'auto', step: stepRequest() },
          onProgress,
          signal,
        );
        isCompacted = summary !== null;
      }
      onProgress({ stage: 'thinking', step });
      const { decision, contextUsage } = await this.decide(stepRequest, step, run);
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
      const turn: ToolTurn = { kind: 'tool', call: accepted.call, result };
      transcript.push(turn);
      const record: ToolMessage = {
        id: this.deps.newId(),
        role: 'tool',
        record: recordToolTurn(turn),
      };
      turnIds.add(record.id);
      conversation.append(record);
    }
  }

  private async decide(
    stepRequest: () => AgentStepRequest,
    step: number,
    run: RequestRun,
  ): Promise<AgentStep> {
    const { agent, compactor } = this.deps;
    try {
      return await agent.decide(stepRequest());
    } catch (error) {
      if (!(error instanceof AssistantContextOverflowError)) throw error;
    }
    await compactor.compact({ kind: 'overflow', step: stepRequest() }, run.onProgress, run.signal);
    run.onProgress({ stage: 'thinking', step });
    return await agent.decideShortened(stepRequest());
  }

  private viewHistory(turnIds: ReadonlySet<string>): ConversationView {
    const history = this.deps.conversation.messages().filter(({ id }) => !turnIds.has(id));
    return viewConversation(history);
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
