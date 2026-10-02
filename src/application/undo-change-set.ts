import {
  canUndoEdits,
  EditStatus,
  getUndoOrder,
  hasPendingEdits,
  recordUndoneEdits,
} from '../domain/change-set';
import type { CompileDiagnostic } from '../domain/agent-transcript';
import type { ProposalMessage, UndoMessage, UndoRefusal } from '../domain/conversation';
import { NotATextFileError, ProjectFileNotFoundError, UndoConflictError } from '../domain/errors';
import { planUndo, type FileChange } from '../domain/file-change';
import { findTextFile, type ProjectFile, type TextFile } from '../domain/project-file';
import type { CancellationSignal } from '../ports/cancellation';
import type { EditorPort } from '../ports/editor-port';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import { FailureRecordingError, NothingToUndoError, UndecidedEditsError } from './errors';
import { ensureNotCancelled, type OperationLock } from './operation-lock';
import { showProjectFile } from './show-project-file';

interface UndoOutcome {
  readonly message: ProposalMessage;
  readonly notice: UndoMessage;
  readonly diagnostics: readonly CompileDiagnostic[] | null;
}

interface UndoRun {
  readonly proposalId: string;
  readonly onProgress: (progress: AgentProgress) => void;
  readonly signal: CancellationSignal;
}

type FileUndo =
  | { readonly kind: 'undone'; readonly message: ProposalMessage }
  | { readonly kind: 'refused'; readonly refusal: UndoRefusal };

export class UndoChangeSet {
  constructor(
    private readonly deps: {
      readonly project: ProjectPort;
      readonly editor: EditorPort;
      readonly conversation: ConversationLog;
      readonly lock: OperationLock;
      readonly newId: () => string;
    },
  ) {}

  execute(proposalId: string, onProgress: (progress: AgentProgress) => void): Promise<UndoOutcome> {
    return this.deps.lock.run(async (signal) => {
      const { conversation, project } = this.deps;
      let message = conversation.findProposal(proposalId);
      if (hasPendingEdits(message.edits)) throw new UndecidedEditsError();
      if (!canUndoEdits(message.edits)) throw new NothingToUndoError();
      const run = { proposalId, onProgress, signal };
      const files = project.listFiles();
      const undone: string[] = [];
      const refused: UndoRefusal[] = [];
      try {
        for (const path of appliedPaths(message)) {
          const outcome = await this.undoFile(files, path, run);
          if (outcome.kind === 'refused') {
            refused.push(outcome.refusal);
            continue;
          }
          message = outcome.message;
          onProgress({ stage: 'decided', message });
          undone.push(path);
        }
      } catch (error) {
        if (undone.length || refused.length) {
          this.recordAfterFailure(error, { proposalId, undone, refused });
        }
        throw error;
      }
      const notice = this.record(proposalId, undone, refused);
      if (undone.length === 0) return { message, notice, diagnostics: null };
      onProgress({ stage: 'compiling' });
      return { message, notice, diagnostics: await project.compile(signal) };
    });
  }

  private async undoFile(
    files: readonly ProjectFile[],
    path: string,
    run: UndoRun,
  ): Promise<FileUndo> {
    const { editor, conversation, project } = this.deps;
    let file: TextFile;
    try {
      file = findTextFile(files, path);
    } catch (error) {
      if (!(error instanceof ProjectFileNotFoundError || error instanceof NotATextFileError)) {
        throw error;
      }
      return { kind: 'refused', refusal: { path, problem: error.message } };
    }
    await showProjectFile(project, file, run.onProgress, run.signal);
    ensureNotCancelled(run.signal);
    const order = getUndoOrder(conversation.findProposal(run.proposalId).edits, path);
    let change: FileChange;
    try {
      change = planUndo(
        path,
        editor.readDocument(file),
        order.map(({ applied }) => applied),
      );
    } catch (error) {
      if (!(error instanceof UndoConflictError)) throw error;
      return { kind: 'refused', refusal: { path, problem: error.message } };
    }
    editor.apply(file, change);
    const indexes = order.map(({ index }) => index);
    const message = conversation.updateProposal(run.proposalId, (edits) =>
      recordUndoneEdits(edits, indexes),
    );
    return { kind: 'undone', message };
  }

  private recordAfterFailure(
    failure: unknown,
    { proposalId, undone, refused }: Pick<UndoMessage, 'proposalId' | 'undone' | 'refused'>,
  ): void {
    try {
      this.record(proposalId, undone, refused);
    } catch (recordingError) {
      throw new FailureRecordingError(failure, recordingError);
    }
  }

  private record(
    proposalId: string,
    undone: readonly string[],
    refused: readonly UndoRefusal[],
  ): UndoMessage {
    const notice: UndoMessage = {
      id: this.deps.newId(),
      role: 'undo',
      proposalId,
      undone,
      refused,
    };
    this.deps.conversation.append(notice);
    return notice;
  }
}

function appliedPaths({ edits }: ProposalMessage): readonly string[] {
  const paths = edits.flatMap((edit) => (edit.status === EditStatus.Applied ? [edit.path] : []));
  return [...new Set(paths)];
}
