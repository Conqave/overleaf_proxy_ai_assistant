import type { ConversationSession, SessionSummary } from '../domain/session';

export interface SessionListing {
  readonly sessions: readonly SessionSummary[];
  readonly unreadableIds: readonly string[];
}

export interface SessionRepository {
  list(): Promise<SessionListing>;
  load(id: string): Promise<ConversationSession>;
  save(session: ConversationSession): Promise<void>;
  delete(id: string): Promise<void>;
}
