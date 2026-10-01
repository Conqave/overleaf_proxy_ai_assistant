import {
  AssistantMessageKind,
  decideProposal,
  isUndecidedProposal,
  ProposalStatus,
  type ConversationMessage,
  type ProposalDecision,
  type ProposalMessage,
} from '../domain/conversation';
import { InvariantViolation } from '../domain/errors';
import {
  appendToSession,
  replaceInSession,
  startSession,
  type ConversationSession,
} from '../domain/session';
import { PersistenceError } from '../ports/errors';
import type { SessionRepository } from '../ports/session-repository';
import { RequestSupersededError } from './errors';

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

  ensureCurrent(epoch: number): void {
    if (this.currentEpoch !== epoch) throw new RequestSupersededError();
  }

  messages(): readonly ConversationMessage[] {
    if (this.current === null) return [];
    return [...this.current.messages];
  }

  show(session: ConversationSession): void {
    this.currentEpoch += 1;
    this.current = session;
    if (session.messages.some(isUndecidedProposal)) this.discardUndecidedProposals(session);
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

  decideProposal(id: string, decision: ProposalDecision): ProposalMessage {
    const session = this.current;
    const proposal = session?.messages.find((message) => message.id === id);
    if (
      session === null ||
      proposal?.role !== 'assistant' ||
      proposal.kind !== AssistantMessageKind.Proposal
    ) {
      throw new InvariantViolation(`the conversation has no proposal ${id}`);
    }
    const decided = decideProposal(proposal, decision);
    this.update(replaceInSession(session, decided, this.deps.now()));
    return decided;
  }

  async takePersistenceFailure(): Promise<PersistenceError | null> {
    await Promise.all(this.writes.splice(0));
    const failure = this.persistenceFailure;
    this.persistenceFailure = null;
    return failure;
  }

  private discardUndecidedProposals(session: ConversationSession): void {
    const messages = session.messages.map((message) =>
      isUndecidedProposal(message) ? decideProposal(message, ProposalStatus.Discarded) : message,
    );
    this.update({ ...session, messages });
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
