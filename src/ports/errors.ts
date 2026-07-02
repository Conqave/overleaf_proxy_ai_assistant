import { OperationalError } from '../domain/errors';

export class AssistantTransportError extends OperationalError {}

export class AssistantTimeoutError extends OperationalError {}

export class AssistantProtocolError extends OperationalError {}

export class AssistantRequestTooLargeError extends OperationalError {}

export class EditorUnavailableError extends OperationalError {}

export class PersistenceError extends OperationalError {}
