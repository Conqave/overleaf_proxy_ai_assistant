export abstract class OperationalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolation';
  }
}

export class InvalidDocumentCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDocumentCommandError';
  }
}

export class InvalidAssistantPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAssistantPlanError';
  }
}

export class DocumentTargetNotFoundError extends OperationalError {}

export class DocumentConflictError extends OperationalError {}

export class DocumentRangeError extends OperationalError {}
