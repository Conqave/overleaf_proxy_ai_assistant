import type { ConversationMessage } from '../domain/conversation';
import { PersistenceError } from '../ports/errors';
import type { ConversationRepository } from '../ports/conversation-repository';
import { RequestSupersededError, UnreadableConversationError } from './errors';

const MAX_STORED_MESSAGES = 80;

export class ConversationLog {
  private items: ConversationMessage[] = [];
  private currentEpoch = 0;
  private persistenceFailure: PersistenceError | UnreadableConversationError | null = null;
  private storedConversationUnreadable = false;

  constructor(private readonly repository: ConversationRepository) {}

  restore(): readonly ConversationMessage[] {
    this.currentEpoch += 1;
    try {
      this.items = this.repository.load();
    } catch (error) {
      if (!(error instanceof PersistenceError)) throw error;
      this.persistenceFailure = new UnreadableConversationError(error);
      this.storedConversationUnreadable = true;
      this.items = [];
    }
    return this.messages();
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  ensureCurrent(epoch: number): void {
    if (this.currentEpoch !== epoch) throw new RequestSupersededError();
  }

  messages(): readonly ConversationMessage[] {
    return [...this.items];
  }

  append(message: ConversationMessage): void {
    this.items = [...this.items, message].slice(-MAX_STORED_MESSAGES);
    this.persist();
  }

  remove(id: string): void {
    this.items = this.items.filter((message) => message.id !== id);
    this.persist();
  }

  clear(): void {
    this.items = [];
    this.currentEpoch += 1;
    try {
      this.repository.clear();
      this.storedConversationUnreadable = false;
    } catch (error) {
      if (!(error instanceof PersistenceError)) throw error;
      this.persistenceFailure = error;
    }
  }

  takePersistenceFailure(): PersistenceError | UnreadableConversationError | null {
    const failure = this.persistenceFailure;
    this.persistenceFailure = null;
    return failure;
  }

  private persist(): void {
    if (this.storedConversationUnreadable) return;
    try {
      this.repository.save(this.items);
    } catch (error) {
      if (!(error instanceof PersistenceError)) throw error;
      this.persistenceFailure = error;
    }
  }
}
