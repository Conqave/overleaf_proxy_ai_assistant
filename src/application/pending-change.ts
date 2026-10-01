import type { ProjectEdit } from '../domain/agent-action';
import {
  ProposalStatus,
  type ProposalDecision,
  type ProposalMessage,
} from '../domain/conversation';
import { InvariantViolation } from '../domain/errors';
import type { ConversationLog } from './conversation-log';
import { ChangeNoLongerPendingError } from './errors';

export class PendingDocumentChange {
  private approved = false;

  constructor(
    readonly id: string,
    readonly change: ProjectEdit,
  ) {}

  get isApproved(): boolean {
    return this.approved;
  }

  approve(): void {
    if (this.approved)
      throw new InvariantViolation(`pending change ${this.id} is already approved`);
    this.approved = true;
  }

  withdrawApproval(): void {
    if (!this.approved) throw new InvariantViolation(`pending change ${this.id} is not approved`);
    this.approved = false;
  }
}

type ApplyOutcome = typeof ProposalStatus.Applied | typeof ProposalStatus.Failed;

export class PendingChanges {
  private readonly changes = new Map<string, PendingDocumentChange>();

  constructor(private readonly conversation: ConversationLog) {}

  add(change: PendingDocumentChange): void {
    if (this.changes.has(change.id)) {
      throw new InvariantViolation(`duplicate pending change id ${change.id}`);
    }
    this.changes.set(change.id, change);
  }

  isPending(id: string): boolean {
    return this.changes.has(id);
  }

  approve(id: string): PendingDocumentChange {
    const change = this.get(id);
    change.approve();
    return change;
  }

  withdrawApproval(id: string): void {
    this.get(id).withdrawApproval();
  }

  reject(id: string): ProposalMessage {
    const change = this.get(id);
    if (change.isApproved) {
      throw new InvariantViolation(`pending change ${id} is being applied and cannot be rejected`);
    }
    return this.close(change, ProposalStatus.Rejected);
  }

  settle(id: string, outcome: ApplyOutcome): ProposalMessage {
    const change = this.get(id);
    if (!change.isApproved) {
      throw new InvariantViolation(
        `pending change ${id} was not approved before it was ${outcome}`,
      );
    }
    return this.close(change, outcome);
  }

  discardAll(): ProposalMessage[] {
    return [...this.changes.values()].map((change) => this.close(change, ProposalStatus.Discarded));
  }

  private get(id: string): PendingDocumentChange {
    const change = this.changes.get(id);
    if (!change) throw new ChangeNoLongerPendingError();
    return change;
  }

  private close(change: PendingDocumentChange, decision: ProposalDecision): ProposalMessage {
    this.changes.delete(change.id);
    return this.conversation.decideProposal(change.id, decision);
  }
}
