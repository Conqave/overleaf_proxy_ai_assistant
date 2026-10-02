import type { ProjectEdit } from '../domain/agent-action';
import {
  decideEdits,
  EditStatus,
  recordAppliedEdits,
  type EditDecision,
} from '../domain/change-set';
import type { ProposalMessage } from '../domain/conversation';
import { InvariantViolation } from '../domain/errors';
import { rebaseEdit, type EditChange } from '../domain/file-change';
import type { ConversationLog } from './conversation-log';
import { ChangeNoLongerPendingError } from './errors';

export interface PendingEdit {
  readonly index: number;
  readonly change: ProjectEdit;
}

export class PendingChanges {
  private readonly changeSets = new Map<string, Map<number, ProjectEdit>>();

  constructor(private readonly conversation: ConversationLog) {}

  add(proposalId: string, changes: readonly ProjectEdit[]): void {
    if (this.changeSets.has(proposalId)) {
      throw new InvariantViolation(`duplicate pending change id ${proposalId}`);
    }
    this.changeSets.set(proposalId, new Map(changes.map((change, index) => [index, change])));
  }

  isPending(proposalId: string): boolean {
    return this.changeSets.has(proposalId);
  }

  select(proposalId: string, indexes: readonly number[] | null): readonly PendingEdit[] {
    const pending = this.get(proposalId);
    const chosen = indexes === null ? [...pending.keys()] : indexes;
    return chosen.map((index) => {
      const change = pending.get(index);
      if (change === undefined) throw new ChangeNoLongerPendingError();
      return { index, change };
    });
  }

  selectFile(proposalId: string, path: string): readonly PendingEdit[] {
    return this.select(proposalId, null).filter(({ change }) => change.file.path === path);
  }

  decide(proposalId: string, indexes: readonly number[], decision: EditDecision): ProposalMessage {
    this.forget(proposalId, indexes);
    return this.conversation.updateProposal(proposalId, (edits) =>
      decideEdits(edits, indexes, decision),
    );
  }

  recordApplied(
    proposalId: string,
    edits: readonly PendingEdit[],
    planned: EditChange,
  ): ProposalMessage {
    const indexes = edits.map(({ index }) => index);
    const applied = planned.applied.map(({ index, applied: splice }) => ({
      index: indexAt(indexes, index),
      applied: splice,
    }));
    this.forget(proposalId, indexes);
    this.rebaseFile(proposalId, getSharedPath(edits), planned);
    return this.conversation.updateProposal(proposalId, (all) => recordAppliedEdits(all, applied));
  }

  discardAll(): ProposalMessage[] {
    return [...this.changeSets].map(([proposalId, pending]) =>
      this.decide(proposalId, [...pending.keys()], EditStatus.Discarded),
    );
  }

  private rebaseFile(proposalId: string, path: string, planned: EditChange): void {
    const pending = this.changeSets.get(proposalId);
    if (pending === undefined) return;
    for (const [index, change] of pending) {
      if (change.file.path !== path) continue;
      pending.set(index, { file: change.file, edit: rebaseEdit(change.edit, planned) });
    }
  }

  private forget(proposalId: string, indexes: readonly number[]): void {
    const pending = this.get(proposalId);
    for (const index of indexes) {
      if (!pending.delete(index)) throw new ChangeNoLongerPendingError();
    }
    if (pending.size === 0) this.changeSets.delete(proposalId);
  }

  private get(proposalId: string): Map<number, ProjectEdit> {
    const pending = this.changeSets.get(proposalId);
    if (pending === undefined) throw new ChangeNoLongerPendingError();
    return pending;
  }
}

function getSharedPath(edits: readonly PendingEdit[]): string {
  const paths = new Set(edits.map(({ change }) => change.file.path));
  const [path] = paths;
  if (path === undefined || paths.size > 1) {
    throw new InvariantViolation('applied edits must belong to exactly one file');
  }
  return path;
}

function indexAt(indexes: readonly number[], position: number): number {
  const index = indexes[position];
  if (index === undefined) throw new InvariantViolation(`no edit at position ${String(position)}`);
  return index;
}
