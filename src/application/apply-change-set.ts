import { EditStatus, type EditRequest } from '../domain/change-set';
import type { ProposalMessage } from '../domain/conversation';
import { assertSameDocument } from '../domain/document';
import { DocumentConflictError } from '../domain/errors';
import { planEditChange } from '../domain/file-change';
import type { TextFile } from '../domain/project-file';
import type { CancellationSignal } from '../ports/cancellation';
import type { AgentProgress, FileConflict } from './agent-progress';
import { concludeDecision, type ChangeSetDeps, type ChangeSetOutcome } from './change-set-outcome';
import { FailureRecordingError } from './errors';
import { ensureNotCancelled, type OperationLock } from './operation-lock';
import { note, recordingFailure } from './notices';
import type { PendingEdit } from './pending-change';
import { showProjectFile } from './show-project-file';

interface ApplyRun {
  readonly proposalId: string;
  readonly onProgress: (progress: AgentProgress) => void;
  readonly signal: CancellationSignal;
}

interface FileEdits {
  readonly file: TextFile;
  readonly edits: readonly PendingEdit[];
}

type FileOutcome =
  | { readonly kind: 'applied'; readonly message: ProposalMessage }
  | {
      readonly kind: 'conflict';
      readonly message: ProposalMessage;
      readonly conflict: FileConflict;
    };

export class ApplyChangeSet {
  constructor(private readonly deps: ChangeSetDeps & { readonly lock: OperationLock }) {}

  execute(
    proposalId: string,
    indexes: readonly number[] | null,
    onProgress: (progress: AgentProgress) => void,
  ): Promise<ChangeSetOutcome> {
    return this.deps.lock.run((signal) =>
      recordingFailure(this.deps.conversation, async () => {
        const run = { proposalId, onProgress, signal };
        const selected = this.deps.pendingChanges.select(proposalId, indexes);
        const applied: EditRequest[] = [];
        const conflicts: FileConflict[] = [];
        let message = this.deps.conversation.findProposal(proposalId);
        for (const { file, edits } of groupByFile(selected)) {
          const outcome = await this.applyFile(file, edits, run);
          message = outcome.message;
          onProgress({ stage: 'decided', message });
          if (outcome.kind === 'conflict') conflicts.push(outcome.conflict);
          else applied.push(...edits.map(({ change }) => describeEdit(change)));
        }
        const { conversation } = this.deps;
        if (applied.length) note(conversation, { kind: 'applied', applied }, onProgress);
        for (const conflict of conflicts) {
          note(conversation, { kind: 'conflict', ...conflict }, onProgress);
        }
        return await concludeDecision(this.deps, message, onProgress, signal);
      }),
    );
  }

  private async applyFile(
    file: TextFile,
    edits: readonly PendingEdit[],
    run: ApplyRun,
  ): Promise<FileOutcome> {
    const { project, editor, pendingChanges } = this.deps;
    const planned = planEditChange(edits.map(({ change }) => change.edit));
    await showProjectFile(project, file, run.onProgress, run.signal);
    ensureNotCancelled(run.signal);
    editor.clearPreview();
    const current = editor.readDocument(file);
    try {
      assertSameDocument(planned.change.before, current);
    } catch (error) {
      if (!(error instanceof DocumentConflictError)) throw error;
      const message = pendingChanges.decide(run.proposalId, indexesOf(edits), EditStatus.Failed);
      return { kind: 'conflict', message, conflict: { path: file.path, problem: error.message } };
    }
    try {
      editor.apply(file, planned.change);
    } catch (error) {
      this.recordWriteFailure(run, edits, error);
      throw error;
    }
    return {
      kind: 'applied',
      message: pendingChanges.recordApplied(run.proposalId, edits, planned),
    };
  }

  private recordWriteFailure(run: ApplyRun, edits: readonly PendingEdit[], failure: unknown): void {
    try {
      const message = this.deps.pendingChanges.decide(
        run.proposalId,
        indexesOf(edits),
        EditStatus.Failed,
      );
      run.onProgress({ stage: 'decided', message });
    } catch (recordingError) {
      throw new FailureRecordingError(failure, recordingError);
    }
  }
}

function groupByFile(edits: readonly PendingEdit[]): readonly FileEdits[] {
  const groups = new Map<string, { file: TextFile; edits: PendingEdit[] }>();
  for (const edit of edits) {
    const { file } = edit.change;
    const group = groups.get(file.path);
    if (group === undefined) groups.set(file.path, { file, edits: [edit] });
    else group.edits.push(edit);
  }
  return [...groups.values()];
}

function indexesOf(edits: readonly PendingEdit[]): readonly number[] {
  return edits.map(({ index }) => index);
}

function describeEdit({ file, edit }: PendingEdit['change']): EditRequest {
  return { path: file.path, command: edit.command };
}
