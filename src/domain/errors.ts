export abstract class NamedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export abstract class OperationalError extends NamedError {}

export class InvariantViolation extends NamedError {}

export class InvalidDocumentCommandError extends NamedError {}

export class DocumentTargetNotFoundError extends OperationalError {}

export class DocumentConflictError extends OperationalError {}

export class DocumentRangeError extends OperationalError {}

export class InvalidProjectPathError extends NamedError {}

export class InvalidProjectTreeError extends NamedError {}

export class InvalidToolCallError extends NamedError {}

export class ToolBudgetExhaustedError extends NamedError {}

export class RepeatedToolCallError extends NamedError {}

export class ToolNotAllowedError extends NamedError {}

export class ScopedSearchNotAllowedError extends NamedError {}

export class ReplyNotAllowedError extends NamedError {}

export class DelegationLimitError extends NamedError {}

export class UncheckedFilesError extends NamedError {}

export class UnreadFileEditError extends NamedError {}

export class UnshownLinesEditError extends NamedError {}

export class OverlappingEditsError extends NamedError {}

export class InvalidChangeSetError extends NamedError {}

export class UndoConflictError extends OperationalError {}

export class ReadRangeError extends NamedError {}

export class InvalidToolRecordError extends NamedError {}

export class ProjectFileNotFoundError extends OperationalError {}

export class NotATextFileError extends OperationalError {}

export class InvalidCompactionSummaryError extends NamedError {}

export class ForeignProjectExportError extends OperationalError {}

export class EmptySessionExportError extends OperationalError {}

export class InvalidWebSearchResultError extends NamedError {}
