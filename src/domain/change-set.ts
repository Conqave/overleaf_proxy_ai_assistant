import type { DocumentCommand } from './document-command';
import { InvalidChangeSetError, InvariantViolation, TooManyEditsError } from './errors';
import type { AppliedEdit, AppliedSplice } from './file-change';

export const MAX_EDITS_PER_CHANGE = 8;

export const EditStatus = {
  Proposed: 'proposed',
  Applied: 'applied',
  Rejected: 'rejected',
  Failed: 'failed',
  Discarded: 'discarded',
  Undone: 'undone',
  AppliedBeforeImport: 'applied-before-import',
} as const;
export type EditStatus = (typeof EditStatus)[keyof typeof EditStatus];

export type EditDecision =
  typeof EditStatus.Rejected | typeof EditStatus.Failed | typeof EditStatus.Discarded;

type UnappliedStatus = Exclude<EditStatus, typeof EditStatus.Applied>;

const EDIT_STATUSES: readonly string[] = Object.values(EditStatus);

export function isEditStatus(value: unknown): value is EditStatus {
  return typeof value === 'string' && EDIT_STATUSES.includes(value);
}

export interface EditRequest {
  readonly path: string;
  readonly command: DocumentCommand;
}

export interface AppliedRecord extends AppliedSplice {
  readonly sequence: number;
}

export type ProposedEdit =
  | (EditRequest & { readonly status: UnappliedStatus })
  | (EditRequest & { readonly status: typeof EditStatus.Applied; readonly applied: AppliedRecord });

export interface FileEdits {
  readonly path: string;
  readonly indexes: readonly number[];
}

export function createChangeSet(requests: readonly EditRequest[]): readonly ProposedEdit[] {
  if (requests.length === 0) throw new InvalidChangeSetError('a change has at least one edit');
  return Object.freeze(
    requests.map(({ path, command }) =>
      Object.freeze({ path, command, status: EditStatus.Proposed }),
    ),
  );
}

export function restoreChangeSet(edits: readonly ProposedEdit[]): readonly ProposedEdit[] {
  if (edits.length === 0) throw new InvalidChangeSetError('a change has at least one edit');
  const sequences = edits.flatMap((edit) =>
    edit.status === EditStatus.Applied ? [edit.applied.sequence] : [],
  );
  if (new Set(sequences).size !== sequences.length) {
    throw new InvalidChangeSetError('two applied edits share one sequence number');
  }
  return Object.freeze(edits.map((edit) => Object.freeze({ ...edit })));
}

export function checkEditCount(count: number): void {
  if (count > MAX_EDITS_PER_CHANGE) {
    throw new TooManyEditsError(
      `one change carries at most ${String(MAX_EDITS_PER_CHANGE)} edits, but this one has ${String(count)}; merge changes of neighbouring lines into one replacement of their line range, or leave the rest for a later request`,
    );
  }
}

export function findPendingEdits(edits: readonly ProposedEdit[]): readonly number[] {
  return edits.flatMap((edit, index) => (edit.status === EditStatus.Proposed ? [index] : []));
}

export function hasPendingEdits(edits: readonly ProposedEdit[]): boolean {
  return edits.some((edit) => edit.status === EditStatus.Proposed);
}

export function hasAppliedEdits(edits: readonly ProposedEdit[]): boolean {
  return edits.some((edit) => edit.status === EditStatus.Applied);
}

export function canUndoEdits(edits: readonly ProposedEdit[]): boolean {
  return hasAppliedEdits(edits) && !hasPendingEdits(edits);
}

export function getUndoOrder(edits: readonly ProposedEdit[], path: string): readonly AppliedEdit[] {
  return edits
    .flatMap((edit, index) =>
      edit.status === EditStatus.Applied && edit.path === path
        ? [{ index, applied: edit.applied }]
        : [],
    )
    .sort((a, b) => b.applied.sequence - a.applied.sequence);
}

export function recordUndoneEdits(
  edits: readonly ProposedEdit[],
  indexes: readonly number[],
): readonly ProposedEdit[] {
  return updateEdits(edits, indexes, (edit) => {
    if (edit.status !== EditStatus.Applied) {
      throw new InvariantViolation(`an edit that is ${edit.status} cannot be undone`);
    }
    return { path: edit.path, command: edit.command, status: EditStatus.Undone };
  });
}

export function recordImportedEdits(edits: readonly ProposedEdit[]): readonly ProposedEdit[] {
  return Object.freeze(
    edits.map((edit) =>
      edit.status === EditStatus.Applied
        ? Object.freeze({
            path: edit.path,
            command: edit.command,
            status: EditStatus.AppliedBeforeImport,
          })
        : edit,
    ),
  );
}

export function groupEditsByPath(edits: readonly ProposedEdit[]): readonly FileEdits[] {
  const groups = new Map<string, number[]>();
  edits.forEach((edit, index) => {
    const group = groups.get(edit.path);
    if (group === undefined) groups.set(edit.path, [index]);
    else group.push(index);
  });
  return [...groups].map(([path, indexes]) => ({ path, indexes }));
}

export function decideEdits(
  edits: readonly ProposedEdit[],
  indexes: readonly number[],
  decision: EditDecision,
): readonly ProposedEdit[] {
  return updateEdits(edits, indexes, (edit) => {
    if (edit.status !== EditStatus.Proposed) {
      throw new InvariantViolation(`an edit that is already ${edit.status} cannot be ${decision}`);
    }
    return { path: edit.path, command: edit.command, status: decision };
  });
}

export function recordAppliedEdits(
  edits: readonly ProposedEdit[],
  appliedInOrder: readonly AppliedEdit[],
): readonly ProposedEdit[] {
  const first = nextSequence(edits);
  const sequences = new Map(appliedInOrder.map(({ index }, position) => [index, first + position]));
  const applied = new Map(appliedInOrder.map((entry) => [entry.index, entry.applied]));
  return updateEdits(edits, [...applied.keys()], (edit, index) => {
    const splice = applied.get(index);
    const sequence = sequences.get(index);
    if (edit.status !== EditStatus.Proposed || splice === undefined || sequence === undefined) {
      throw new InvariantViolation(`edit ${String(index)} cannot be applied now`);
    }
    return {
      path: edit.path,
      command: edit.command,
      status: EditStatus.Applied,
      applied: { ...splice, sequence },
    };
  });
}

function nextSequence(edits: readonly ProposedEdit[]): number {
  const sequences = edits.flatMap((edit) =>
    edit.status === EditStatus.Applied ? [edit.applied.sequence] : [],
  );
  return sequences.length ? Math.max(...sequences) + 1 : 0;
}

function updateEdits(
  edits: readonly ProposedEdit[],
  indexes: readonly number[],
  update: (edit: ProposedEdit, index: number) => ProposedEdit,
): readonly ProposedEdit[] {
  const chosen = new Set(indexes);
  if (chosen.size !== indexes.length || indexes.some((index) => edits[index] === undefined)) {
    throw new InvariantViolation(`the change has no edits ${indexes.join(', ')}`);
  }
  return Object.freeze(
    edits.map((edit, index) => (chosen.has(index) ? Object.freeze(update(edit, index)) : edit)),
  );
}
