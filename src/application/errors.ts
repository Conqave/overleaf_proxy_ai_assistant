import { NamedError, OperationalError } from '../domain/errors';
import { AGENT_POLICY } from '../domain/agent-policy';

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
  constructor(readonly lastMistake: Error) {
    super(
      `The assistant took ${String(AGENT_POLICY.maxConsecutiveMistakes)} invalid steps in a row and stopped (last: ${lastMistake.message}). Please rephrase the request.`,
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

export class InvalidChangeSetEditError extends NamedError {
  constructor(index: number, count: number, path: string, mistake: Error) {
    super(`edit ${String(index + 1)} of ${String(count)} (${path}): ${mistake.message}`, {
      cause: mistake,
    });
  }
}
