import type { ProposedEdit } from '../domain/change-set';
import {
  AssistantMessageKind,
  type ConversationMessage,
  type ImportedHistory,
  type ProposalMessage,
} from '../domain/conversation';
import { InvariantViolation } from '../domain/errors';
import {
  appendToSession,
  discardUndecidedProposals,
  hasUndecidedProposals,
  holdsUntrustedContent,
  holdsUntrustedContentSince,
  replaceInSession,
  startSession,
  type ConversationSession,
} from '../domain/session';
import { PersistenceError } from '../ports/errors';
import type { SessionRepository } from '../ports/session-repository';

export class ConversationLog {
  private current: ConversationSession | null = null;
  private currentEpoch = 0;
  private persistenceFailure: PersistenceError | null = null;
  private readonly writes: Promise<void>[] = [];

  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      newId: () => string;
      now: () => number;
    },
  ) {}

  get epoch(): number {
    return this.currentEpoch;
  }

  get sessionId(): string | null {
    return this.current === null ? null : this.current.id;
  }

  get imported(): ImportedHistory | null {
    return this.current === null ? null : this.current.imported;
  }

  holdsUntrustedContent(): boolean {
    return this.current !== null && holdsUntrustedContent(this.current);
  }

  holdsUntrustedContentSince(messageId: string): boolean {
    if (this.current === null) {
      throw new InvariantViolation(`message ${messageId} is outside of a session`);
    }
    return holdsUntrustedContentSince(this.current, messageId);
  }

  messages(): readonly ConversationMessage[] {
    if (this.current === null) return [];
    return [...this.current.messages];
  }

  show(session: ConversationSession): void {
    this.currentEpoch += 1;
    this.current = session;
    if (hasUndecidedProposals(session)) this.update(discardUndecidedProposals(session));
  }

  startNew(): void {
    this.currentEpoch += 1;
    this.current = null;
  }

  append(message: ConversationMessage): void {
    const now = this.deps.now();
    if (this.current !== null) {
      this.update(appendToSession(this.current, message, now));
      return;
    }
    if (message.role !== 'user') {
      throw new InvariantViolation(`a session cannot start with a ${message.role} message`);
    }
    this.update(startSession(this.deps.newId(), message, now));
  }

  findProposal(id: string): ProposalMessage {
    const proposal = this.current?.messages.find((message) => message.id === id);
    if (proposal?.role !== 'assistant' || proposal.kind !== AssistantMessageKind.Proposal) {
      throw new InvariantViolation(`the conversation has no proposal ${id}`);
    }
    return proposal;
  }

  updateProposal(
    id: string,
    update: (edits: readonly ProposedEdit[]) => readonly ProposedEdit[],
  ): ProposalMessage {
    const proposal = this.findProposal(id);
    const session = this.current;
    if (session === null) throw new InvariantViolation('a proposal is shown without a session');
    const updated = { ...proposal, edits: update(proposal.edits) };
    this.update(replaceInSession(session, updated, this.deps.now()));
    return updated;
  }

  async takePersistenceFailure(): Promise<PersistenceError | null> {
    await Promise.all(this.writes.splice(0));
    const failure = this.persistenceFailure;
    this.persistenceFailure = null;
    return failure;
  }

  private update(session: ConversationSession): void {
    this.current = session;
    this.writes.push(this.save(session));
  }

  private async save(session: ConversationSession): Promise<void> {
    try {
      await this.deps.sessions.save(session);
    } catch (error) {
      if (!(error instanceof PersistenceError)) throw error;
      this.persistenceFailure ??= error;
    }
  }
}
