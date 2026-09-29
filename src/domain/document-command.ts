import { createDocumentTarget, type DocumentTarget } from './document-target';
import { InvalidDocumentCommandError } from './errors';

export const DocumentOperation = {
  InsertBefore: 'insert_before',
  InsertAfter: 'insert_after',
  Replace: 'replace',
  Delete: 'delete',
} as const;

export type DocumentOperation = (typeof DocumentOperation)[keyof typeof DocumentOperation];

const OPERATIONS: readonly string[] = Object.values(DocumentOperation);

export function isDocumentOperation(value: unknown): value is DocumentOperation {
  return typeof value === 'string' && OPERATIONS.includes(value);
}

interface CommandBase {
  readonly target: DocumentTarget;
  readonly reason: string;
}

export type DocumentCommand =
  | (CommandBase & { readonly operation: 'insert_before'; readonly content: string })
  | (CommandBase & { readonly operation: 'insert_after'; readonly content: string })
  | (CommandBase & {
      readonly operation: 'replace';
      readonly lineCount: number;
      readonly content: string;
    })
  | (CommandBase & { readonly operation: 'delete'; readonly lineCount: number });

export interface DocumentCommandInput {
  readonly operation: unknown;
  readonly target?: unknown;
  readonly lineCount?: unknown;
  readonly content?: unknown;
  readonly reason?: unknown;
}

export function createDocumentCommand(input: DocumentCommandInput): DocumentCommand {
  const { operation } = input;
  if (!isDocumentOperation(operation)) {
    throw new InvalidDocumentCommandError(`unknown operation: ${JSON.stringify(operation)}`);
  }
  const target = parseTarget(input.target);
  if (input.reason !== undefined && typeof input.reason !== 'string') {
    throw new InvalidDocumentCommandError('reason must be a string');
  }
  const reason = (input.reason ?? '').trim();

  if (operation === DocumentOperation.Delete) {
    if (input.content !== undefined) {
      throw new InvalidDocumentCommandError('delete must not carry content');
    }
    return Object.freeze({ operation, target, lineCount: parseLineCount(input.lineCount), reason });
  }
  if (typeof input.content !== 'string' || input.content.trim() === '') {
    throw new InvalidDocumentCommandError(`${operation} requires non-empty content`);
  }
  const content = input.content;
  if (operation === DocumentOperation.Replace) {
    const lineCount = parseLineCount(input.lineCount);
    return Object.freeze({ operation, target, lineCount, reason, content });
  }
  if (input.lineCount !== undefined) {
    throw new InvalidDocumentCommandError(
      `${operation} anchors on one line and takes no line count`,
    );
  }
  return Object.freeze({ operation, target, reason, content });
}

function parseLineCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new InvalidDocumentCommandError('line count must be a positive integer');
  }
  return value;
}

function parseTarget(value: unknown): DocumentTarget {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidDocumentCommandError('target is required');
  }
  const fields = new Map(Object.entries(value));
  return createDocumentTarget(fields.get('lineNumber'), fields.get('lineText'));
}
