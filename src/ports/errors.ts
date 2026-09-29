import { OperationalError } from '../domain/errors';

export class AssistantHttpError extends OperationalError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class AssistantUnreachableError extends OperationalError {}

export class AssistantResponseContractError extends OperationalError {}

export class AssistantTimeoutError extends OperationalError {}

export class AssistantProtocolError extends OperationalError {}

export class AssistantRequestTooLargeError extends OperationalError {}

export class EditorUnavailableError extends OperationalError {}

export class PersistenceError extends OperationalError {}
