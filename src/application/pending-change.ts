import type { ProjectEdit } from '../domain/agent-action';
import { InvariantViolation } from '../domain/errors';
import { ChangeNoLongerPendingError } from './errors';

export type PendingChangeStatus =
  'validated' | 'previewed' | 'approved' | 'applied' | 'failed' | 'rejected' | 'discarded';

interface Transition {
  readonly from: readonly PendingChangeStatus[];
  readonly closed: readonly PendingChangeStatus[];
  readonly to: PendingChangeStatus;
}

const OPEN: readonly PendingChangeStatus[] = ['validated', 'previewed'];

const CLOSED: readonly PendingChangeStatus[] = ['applied', 'failed', 'rejected', 'discarded'];

const PREVIEW: Transition = { from: ['validated'], closed: [], to: 'previewed' };
const APPROVE: Transition = { from: ['previewed'], closed: CLOSED, to: 'approved' };
const REJECT: Transition = { from: ['previewed'], closed: CLOSED, to: 'rejected' };
const MARK_APPLIED: Transition = { from: ['approved'], closed: [], to: 'applied' };
const MARK_FAILED: Transition = { from: ['approved'], closed: [], to: 'failed' };
const DISCARD: Transition = { from: OPEN, closed: [], to: 'discarded' };

export class PendingDocumentChange {
  private status: PendingChangeStatus = 'validated';

  constructor(
    readonly id: string,
    readonly change: ProjectEdit,
  ) {}

  get isOpen(): boolean {
    return OPEN.includes(this.status);
  }

  get isClosed(): boolean {
    return CLOSED.includes(this.status);
  }

  markPreviewed(): void {
    this.transition(PREVIEW);
  }

  approve(): void {
    this.transition(APPROVE);
  }

  reject(): void {
    this.transition(REJECT);
  }

  markApplied(): void {
    this.transition(MARK_APPLIED);
  }

  markFailed(): void {
    this.transition(MARK_FAILED);
  }

  discard(): void {
    this.transition(DISCARD);
  }

  private transition({ from, closed, to }: Transition): void {
    if (from.includes(this.status)) {
      this.status = to;
      return;
    }
    if (closed.includes(this.status)) throw new ChangeNoLongerPendingError();
    throw new InvariantViolation(
      `pending change ${this.id}: cannot go from ${this.status} to ${to}`,
    );
  }
}

export class PendingChanges {
  private readonly changes = new Map<string, PendingDocumentChange>();

  add(change: PendingDocumentChange): void {
    if (this.changes.has(change.id)) {
      throw new InvariantViolation(`duplicate pending change id ${change.id}`);
    }
    this.changes.set(change.id, change);
  }

  get(id: string): PendingDocumentChange {
    const change = this.changes.get(id);
    if (!change) throw new ChangeNoLongerPendingError();
    return change;
  }

  discardAll(): PendingDocumentChange[] {
    const open = [...this.changes.values()].filter((change) => change.isOpen);
    for (const change of open) change.discard();
    for (const [id, change] of this.changes) {
      if (change.isClosed) this.changes.delete(id);
    }
    return open;
  }
}
