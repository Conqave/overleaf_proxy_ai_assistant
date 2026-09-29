import { OperationalError } from '../domain/errors';
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
