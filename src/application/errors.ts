import { OperationalError } from '../domain/errors';
import { AGENT_POLICY } from '../domain/agent-policy';
import type { PersistenceError } from '../ports/errors';
import type { PendingChangeStatus } from './pending-change';

export class EmptyRequestError extends OperationalError {
  constructor() {
    super('Please enter a command for the assistant.');
  }
}

export class RequestInProgressError extends OperationalError {
  constructor() {
    super('The assistant is still working on the previous request.');
  }
}

export class RequestSupersededError extends OperationalError {
  constructor() {
    super('The conversation was reset before the assistant finished; the reply was dropped.');
  }
}

export class ChangeNoLongerPendingError extends OperationalError {
  constructor(status: PendingChangeStatus) {
    super(`This suggestion can no longer be used (it was ${status}).`);
  }
}

export class UnreadableConversationError extends OperationalError {
  constructor(cause: PersistenceError) {
    super(
      `${cause.message} It stays stored, and this chat is not saved, until you start a new chat.`,
      { cause },
    );
  }
}

export class AgentMistakeLimitError extends OperationalError {
  constructor(lastMistake: Error) {
    super(
      `The assistant took ${String(AGENT_POLICY.maxConsecutiveMistakes)} invalid steps in a row and stopped (last: ${lastMistake.message}). Please rephrase the request.`,
      { cause: lastMistake },
    );
  }
}
