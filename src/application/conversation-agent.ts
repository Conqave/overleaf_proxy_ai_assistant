import type { ProjectEdit } from '../domain/agent-action';
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
import { ProjectFileKind, type ProjectFile, type TextFile } from '../domain/project-file';
import type { ResolvedEdit } from '../domain/resolved-edit';
import type { ContextUsage } from '../domain/context-usage';
import type { AgentWorkspace, ConversationRequest } from '../ports/agent-port';
import type { CancellationSignal } from '../ports/cancellation';
import type { EditorPort } from '../ports/editor-port';
import type { ProjectPort } from '../ports/project-port';
import type { AcceptedReply } from './agent-decision';
import type { AgentLoop } from './agent-loop';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import { ensureNotCancelled, type OperationLock } from './operation-lock';
import type { PendingChanges } from './pending-change';
import { showProjectFile } from './show-project-file';

interface RequestRun {
  readonly signal: CancellationSignal;
  readonly onProgress: (progress: AgentProgress) => void;
}

interface Workspace {
  readonly view: AgentWorkspace;
  readonly shown: ProjectFile;
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
      readonly previewShown: boolean;
      readonly contextUsage: ContextUsage;
    };

interface Proposal {
  readonly message: ProposalMessage;
  readonly previewShown: boolean;
}

export class ConversationAgent {
  constructor(
    private readonly deps: {
      loop: AgentLoop;
      project: ProjectPort;
      editor: EditorPort;
      conversation: ConversationLog;
      pendingChanges: PendingChanges;
      lock: Pick<OperationLock, 'assertHeld'>;
      newId: () => string;
    },
  ) {}

  async respond(
    text: string,
    onProgress: (progress: AgentProgress) => void,
    signal: CancellationSignal,
  ): Promise<AgentResult> {
    this.deps.lock.assertHeld();
    const message: UserMessage = { id: this.deps.newId(), role: 'user', text };
    this.receive(message, onProgress);
    return await this.runAgent({ kind: 'user', message }, { signal, onProgress });
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
    const { conversation, pendingChanges } = this.deps;
    for (const proposal of pendingChanges.discardAll())
      onProgress({ stage: 'decided', message: proposal });
    conversation.append(message);
    onProgress({ stage: 'received', message });
  }

  private async runAgent(request: ConversationRequest, run: RequestRun): Promise<AgentResult> {
    const { conversation } = this.deps;
    const { signal, onProgress } = run;
    const workspace = await this.readWorkspace(signal);
    ensureNotCancelled(signal);
    const turnIds = new Set([request.message.id]);
    const { reply, contextUsage } = await this.deps.loop.run({
      request,
      workspace: workspace.view,
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
      onProgress: (progress) => {
        if (progress.stage === 'measured') conversation.recordContextUsage(progress.contextUsage);
        onProgress(progress);
      },
    });
    return await this.answer(reply, contextUsage, workspace.shown, run);
  }

  private viewHistory(turnIds: ReadonlySet<string>): ConversationView {
    const { conversation } = this.deps;
    const history = conversation.messages().filter(({ id }) => !turnIds.has(id));
    return viewConversation(history, conversation.imported);
  }

  private async readWorkspace(signal: CancellationSignal): Promise<Workspace> {
    const { project, editor } = this.deps;
    const files = project.listFiles();
    const shown = project.shownFile();
    if (shown.kind === ProjectFileKind.Binary) {
      return {
        view: { files, openFile: { kind: ProjectFileKind.Binary, path: shown.path } },
        shown,
      };
    }
    await project.openFile(shown, signal);
    return {
      view: {
        files,
        openFile: {
          kind: ProjectFileKind.Text,
          path: shown.path,
          document: editor.readDocument(shown),
          cursorLine: editor.readCursorLine(shown),
          selection: editor.readSelection(shown),
        },
      },
      shown,
    };
  }

  private async answer(
    reply: AcceptedReply,
    contextUsage: ContextUsage,
    requestFile: ProjectFile,
    run: RequestRun,
  ): Promise<AgentResult> {
    switch (reply.kind) {
      case 'answer':
        return { kind: 'reply', message: this.reply('explanation', reply.text), contextUsage };
      case 'question':
        return { kind: 'reply', message: this.reply('clarification', reply.text), contextUsage };
      case 'edit': {
        const proposal = await this.propose(reply.changes, requestFile, run);
        return { kind: 'proposal', ...proposal, contextUsage };
      }
    }
  }

  private async propose(
    changes: readonly ProjectEdit[],
    requestFile: ProjectFile,
    { signal, onProgress }: RequestRun,
  ): Promise<Proposal> {
    const { project, editor, conversation, pendingChanges } = this.deps;
    const [first] = changes;
    if (first === undefined) throw new InvariantViolation('an accepted edit has no changes');
    if (project.isShown(requestFile)) {
      await showProjectFile(project, first.file, onProgress, signal);
      ensureNotCancelled(signal);
    }
    const shown = changes.map(({ file }) => file).find((file) => project.isShown(file));
    if (shown === undefined) {
      const current = await project.readFile(first.file, signal);
      ensureNotCancelled(signal);
      for (const edit of editsOf(changes, first.file)) edit.assertCurrent(current);
    } else {
      const previewed = editsOf(changes, shown);
      const current = editor.readDocument(shown);
      for (const edit of previewed) edit.assertCurrent(current);
      editor.showPreview(shown, previewed);
    }
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
    return { message, previewShown: shown !== undefined };
  }

  private reply(kind: ReplyMessage['kind'], text: string): ReplyMessage {
    const message: ReplyMessage = { id: this.deps.newId(), role: 'assistant', kind, text };
    this.deps.conversation.append(message);
    return message;
  }
}

function editsOf(changes: readonly ProjectEdit[], file: TextFile): readonly ResolvedEdit[] {
  return changes.filter((change) => change.file.path === file.path).map(({ edit }) => edit);
}
