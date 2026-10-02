import { AgentMistakeError, NamedError, OperationalError } from '../domain/errors';
import type { AutoApprovalScope } from './web-search-approval';

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
  constructor() {
    super('This suggestion can no longer be used; ask again for a new one.');
  }
}

export class WebSearchNoLongerPendingError extends OperationalError {
  constructor() {
    super('This web search no longer waits for a decision.');
  }
}

export class AutoApprovalUnavailableError extends OperationalError {
  constructor(scope: AutoApprovalScope) {
    super(
      `Web results or imported messages are already in this ${scope}, so each search needs its own approval.`,
    );
  }
}

export class NothingToCompactError extends OperationalError {
  constructor() {
    super('There is nothing to compact yet: the latest turn always stays in full.');
  }
}

export class NothingToUndoError extends OperationalError {
  constructor() {
    super('Hans has applied nothing of this change that could be undone.');
  }
}

export class UndecidedEditsError extends OperationalError {
  constructor() {
    super('Apply or reject the open edits of this change before undoing it.');
  }
}

export class AgentMistakeLimitError extends OperationalError {
  constructor(
    readonly lastMistake: AgentMistakeError,
    readonly limit: number,
  ) {
    super(
      `The assistant took ${String(limit)} invalid steps in a row and stopped (last: ${lastMistake.message}). Please rephrase the request.`,
      { cause: lastMistake },
    );
  }
}

export class FailureRecordingError extends NamedError {
  constructor(
    readonly failure: unknown,
    recordingError: unknown,
  ) {
    super('Recording the outcome of a failed operation failed as well.', { cause: recordingError });
  }
}

export class InvalidChangeSetEditError extends AgentMistakeError {
  constructor(index: number, count: number, path: string, mistake: AgentMistakeError) {
    super(`edit ${String(index + 1)} of ${String(count)} (${path}): ${mistake.message}`, {
      cause: mistake,
    });
  }
}
