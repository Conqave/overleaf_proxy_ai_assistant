import type { ResolvedEdit } from '../domain/resolved-edit';
import { InvariantViolation } from '../domain/errors';
import { ChangeNoLongerPendingError } from './errors';

export type PendingChangeStatus =
  'validated' | 'previewed' | 'approved' | 'applied' | 'failed' | 'rejected' | 'discarded';

export class PendingDocumentChange {
  private currentStatus: PendingChangeStatus = 'validated';

  constructor(
    readonly id: string,
    readonly edit: ResolvedEdit,
    readonly messageId: string,
  ) {}

  get status(): PendingChangeStatus {
    return this.currentStatus;
  }

  get isOpen(): boolean {
    return this.currentStatus === 'validated' || this.currentStatus === 'previewed';
  }

  markPreviewed(): void {
    this.transition(['validated'], 'previewed');
  }

  approve(): void {
    this.transition(['previewed'], 'approved');
  }

  reject(): void {
    this.transition(['previewed'], 'rejected');
  }

  markApplied(): void {
    this.transition(['approved'], 'applied');
  }

  markFailed(): void {
    this.transition(['approved'], 'failed');
  }

  discard(): void {
    this.transition(['validated', 'previewed'], 'discarded');
  }

  private transition(from: readonly PendingChangeStatus[], to: PendingChangeStatus): void {
    if (from.includes(this.currentStatus)) {
      this.currentStatus = to;
      return;
    }
    if (this.currentStatus === 'validated' || this.currentStatus === 'approved') {
      throw new InvariantViolation(
        `pending change ${this.id}: cannot go from ${this.currentStatus} to ${to}`,
      );
    }
    throw new ChangeNoLongerPendingError(this.currentStatus);
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
    if (!change) throw new InvariantViolation(`unknown pending change ${id}`);
    return change;
  }

  discardAll(): PendingDocumentChange[] {
    const open = [...this.changes.values()].filter((change) => change.isOpen);
    for (const change of open) change.discard();
    return open;
  }
}
