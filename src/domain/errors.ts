abstract class NamedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export abstract class OperationalError extends NamedError {}

export class InvariantViolation extends NamedError {}

export class InvalidDocumentCommandError extends NamedError {}

export class InvalidAssistantPlanError extends NamedError {}

export class DocumentTargetNotFoundError extends OperationalError {}

export class DocumentConflictError extends OperationalError {}

export class DocumentRangeError extends OperationalError {}
