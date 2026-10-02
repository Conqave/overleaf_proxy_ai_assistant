import type { ProjectEdit } from '../domain/agent-action';
import { createAgentPolicies } from '../domain/agent-policy';
import { recordToolTurn, type CompileDiagnostic } from '../domain/agent-transcript';
import { createChangeSet } from '../domain/change-set';
import type {
  ProposalMessage,
  ReplyMessage,
  SystemRequestMessage,
  ToolMessage,
  UserMessage,
} from '../domain/conversation';
import { viewConversation, type ConversationView } from '../domain/conversation-view';
import { InvariantViolation } from '../domain/errors';
import type { TextFile } from '../domain/project-file';
import type {
  AgentPort,
  AgentWorkspace,
  ContextUsage,
  ConversationRequest,
} from '../ports/agent-port';
import type { CancellationController, CancellationSignal } from '../ports/cancellation';
import type { EditorPort } from '../ports/editor-port';
import type { ProjectPort } from '../ports/project-port';
import type { AcceptedReply } from './agent-decision';
import { AgentLoop } from './agent-loop';
import type { AgentProgress } from './agent-progress';
import type { ConversationCompactor } from './conversation-compactor';
import type { ConversationLog } from './conversation-log';
import { EmptyRequestError } from './errors';
import { ensureNotCancelled, type OperationLock } from './operation-lock';
import type { PendingChanges } from './pending-change';
import { ProjectTools } from './project-tools';
import { showProjectFile } from './show-project-file';
import type { WebSearchTool } from './web-search-tool';

export type { ContextPressure, ContextUsage } from '../ports/agent-port';

interface RequestRun {
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
      readonly contextUsage: ContextUsage;
    };

export class HandleAssistantRequest {
  private readonly loop: AgentLoop;

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
      webSearch: WebSearchTool | null;
    },
  ) {
    this.loop = new AgentLoop({
      agent: deps.agent,
      compactor: deps.compactor,
      tools: new ProjectTools(deps.project, deps.createController),
      webSearch: deps.webSearch,
      policies: createAgentPolicies({ webSearch: deps.webSearch !== null }),
    });
  }

  getUnusedContext(): ContextUsage {
    return this.deps.agent.idleUsage;
  }

  async execute(text: string, onProgress: (progress: AgentProgress) => void): Promise<AgentResult> {
    const request = text.trim();
    if (!request) throw new EmptyRequestError();
    return await this.deps.lock.run(async (signal) => {
      const message: UserMessage = { id: this.deps.newId(), role: 'user', text: request };
      this.receive(message, onProgress);
      return await this.runAgent({ kind: 'user', message }, { signal, onProgress });
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
    this.receive(message, onProgress);
    return await this.runAgent(
      { kind: 'compile-fix', message, diagnostics },
      { signal, onProgress },
    );
  }

  private receive(
    message: UserMessage | SystemRequestMessage,
    onProgress: (progress: AgentProgress) => void,
  ): void {
    const { editor, conversation, pendingChanges } = this.deps;
    const discarded = pendingChanges.discardAll();
    if (discarded.length) editor.clearPreview();
    for (const proposal of discarded) onProgress({ stage: 'decided', message: proposal });
    conversation.append(message);
    onProgress({ stage: 'received', message });
  }

  private async runAgent(request: ConversationRequest, run: RequestRun): Promise<AgentResult> {
    const { conversation } = this.deps;
    const { signal, onProgress } = run;
    const workspace = await this.readWorkspace(signal);
    ensureNotCancelled(signal);
    const turnIds = new Set([request.message.id]);
    const { reply, contextUsage } = await this.loop.run({
      request,
      workspace,
      host: {
        viewHistory: () => this.viewHistory(turnIds),
        recordLookup: (turn) => {
          const record: ToolMessage = {
            id: this.deps.newId(),
            role: 'tool',
            record: recordToolTurn(turn),
          };
          turnIds.add(record.id);
          conversation.append(record);
          onProgress({ stage: 'recorded', message: record });
        },
      },
      signal,
      onProgress,
    });
    return await this.answer(reply, contextUsage, run);
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
    reply: AcceptedReply,
    contextUsage: ContextUsage,
    { signal, onProgress }: RequestRun,
  ): Promise<AgentResult> {
    switch (reply.kind) {
      case 'answer':
        return { kind: 'reply', message: this.reply('explanation', reply.text), contextUsage };
      case 'question':
        return { kind: 'reply', message: this.reply('clarification', reply.text), contextUsage };
      case 'edit': {
        const [first] = reply.changes;
        if (first === undefined) throw new InvariantViolation('an accepted edit has no changes');
        await showProjectFile(this.deps.project, first.file, onProgress, signal);
        ensureNotCancelled(signal);
        return { kind: 'proposal', message: this.propose(first.file, reply.changes), contextUsage };
      }
    }
  }

  private propose(shown: TextFile, changes: readonly ProjectEdit[]): ProposalMessage {
    const { editor, conversation, pendingChanges } = this.deps;
    const previewed = changes
      .filter(({ file }) => file.path === shown.path)
      .map(({ edit }) => edit);
    const current = editor.readDocument(shown);
    for (const edit of previewed) edit.assertCurrent(current);
    editor.showPreview(shown, previewed);
    const message: ProposalMessage = {
      id: this.deps.newId(),
      role: 'assistant',
      kind: 'proposal',
      edits: createChangeSet(
        changes.map(({ file, edit }) => ({ path: file.path, command: edit.command })),
      ),
    };
    conversation.append(message);
    pendingChanges.add(message.id, changes);
    return message;
  }

  private reply(kind: ReplyMessage['kind'], text: string): ReplyMessage {
    const message: ReplyMessage = { id: this.deps.newId(), role: 'assistant', kind, text };
    this.deps.conversation.append(message);
    return message;
  }
}
