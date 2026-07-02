import type { ConversationMessage } from '../domain/conversation';

export interface ConversationRepository {
  load(): ConversationMessage[];
  save(messages: readonly ConversationMessage[]): void;
  clear(): void;
}
