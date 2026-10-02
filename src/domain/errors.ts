export abstract class NamedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export abstract class OperationalError extends NamedError {}

export abstract class AgentMistakeError extends OperationalError {}

export class InvariantViolation extends NamedError {}

export class InvalidDocumentCommandError extends NamedError {}

export class DocumentTargetNotFoundError extends AgentMistakeError {}

export class DocumentConflictError extends OperationalError {}

export class DocumentRangeError extends AgentMistakeError {}

export class InvalidProjectPathError extends NamedError {}

export class InvalidProjectTreeError extends NamedError {}

export class InvalidToolCallError extends NamedError {}

export class ToolBudgetExhaustedError extends AgentMistakeError {}

export class RepeatedToolCallError extends AgentMistakeError {}

export class ToolNotAllowedError extends AgentMistakeError {}

export class ScopedSearchNotAllowedError extends AgentMistakeError {}

export class ReplyNotAllowedError extends AgentMistakeError {}

export class DelegationLimitError extends AgentMistakeError {}

export class UncheckedFilesError extends AgentMistakeError {}

export class UnreadFileEditError extends AgentMistakeError {}

export class BibFieldSeparatorError extends AgentMistakeError {}

export class UnshownLinesEditError extends AgentMistakeError {}

export class OverlappingEditsError extends AgentMistakeError {}

export class InvalidChangeSetError extends NamedError {}

export class TooManyEditsError extends AgentMistakeError {}

export class UndoConflictError extends OperationalError {}

export class ReadRangeError extends AgentMistakeError {}

export class InvalidToolRecordError extends NamedError {}

export class ProjectFileNotFoundError extends AgentMistakeError {}

export class NotATextFileError extends AgentMistakeError {}

export class InvalidCompactionSummaryError extends NamedError {}

export class ForeignProjectExportError extends OperationalError {}

export class EmptySessionExportError extends OperationalError {}

export class InvalidWebSearchResultError extends NamedError {}
