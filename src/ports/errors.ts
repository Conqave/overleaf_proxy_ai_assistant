import { OperationalError } from '../domain/errors';

export class AssistantHttpError extends OperationalError {}

export class AssistantUnreachableError extends OperationalError {}

export class AssistantResponseContractError extends OperationalError {}

export class AssistantTimeoutError extends OperationalError {}

export class AssistantProtocolError extends OperationalError {}

export class AssistantRequestTooLargeError extends OperationalError {}

export class AssistantContextOverflowError extends OperationalError {}

export class AssistantReplyTruncatedError extends OperationalError {}

export class EditorUnavailableError extends OperationalError {}

export class EditorShowsOtherFileError extends OperationalError {}

export abstract class PersistenceError extends OperationalError {}

export class SessionStorageError extends PersistenceError {}

export class UnreadableSessionError extends PersistenceError {}

export class SessionNotFoundError extends PersistenceError {}

export class UnreadableSessionExportError extends OperationalError {}

export class ProjectUnavailableError extends OperationalError {}

export class ProjectFileReadError extends OperationalError {}

export class ProjectFileReadTimeoutError extends OperationalError {}

export class ProjectFileWriteError extends OperationalError {}

export class ProjectFileWriteTimeoutError extends OperationalError {}

export class FileOpenTimeoutError extends OperationalError {}

export class CompileTimeoutError extends OperationalError {}

export class CompileWithoutResultError extends OperationalError {}

export class UnexplainedCompileFailureError extends OperationalError {}

export class EditsNotSavedError extends OperationalError {}

export class NoOpenTextFileError extends OperationalError {}

export class ProjectTreeOutdatedError extends OperationalError {}
