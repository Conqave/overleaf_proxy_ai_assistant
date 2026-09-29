import { createDocumentTarget, type DocumentTarget } from './document-target';
import { InvalidDocumentCommandError } from './errors';

export const DocumentOperation = {
  InsertBefore: 'insert_before',
  InsertAfter: 'insert_after',
  Replace: 'replace',
  Delete: 'delete',
} as const;

export type DocumentOperation = (typeof DocumentOperation)[keyof typeof DocumentOperation];

export type AnchorOperation =
  typeof DocumentOperation.InsertBefore | typeof DocumentOperation.InsertAfter;

export type RangeOperation = typeof DocumentOperation.Replace | typeof DocumentOperation.Delete;

const OPERATIONS: readonly string[] = Object.values(DocumentOperation);

export function isDocumentOperation(value: unknown): value is DocumentOperation {
  return typeof value === 'string' && OPERATIONS.includes(value);
}

interface CommandBase {
  readonly target: DocumentTarget;
  readonly reason?: string;
}

export type DocumentCommand =
  | (CommandBase & { readonly operation: AnchorOperation; readonly content: string })
  | (CommandBase & {
      readonly operation: typeof DocumentOperation.Replace;
      readonly lineCount: number;
      readonly content: string;
    })
  | (CommandBase & {
      readonly operation: typeof DocumentOperation.Delete;
      readonly lineCount: number;
    });

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
  const reason = parseReason(input.reason);

  if (operation === DocumentOperation.Delete) {
    if (input.content !== undefined) {
      throw new InvalidDocumentCommandError('delete must not carry content');
    }
    const lineCount = parseLineCount(operation, target, input.lineCount);
    return Object.freeze({ operation, target, lineCount, ...reason });
  }
  if (typeof input.content !== 'string' || input.content.trim() === '') {
    throw new InvalidDocumentCommandError(`${operation} requires non-empty content`);
  }
  const content = input.content;
  if (operation === DocumentOperation.Replace) {
    const lineCount = parseLineCount(operation, target, input.lineCount);
    return Object.freeze({ operation, target, lineCount, content, ...reason });
  }
  if (input.lineCount !== undefined) {
    throw new InvalidDocumentCommandError(
      `${operation} anchors on one line and takes no range end`,
    );
  }
  return Object.freeze({ operation, target, content, ...reason });
}

function parseLineCount(operation: string, target: DocumentTarget, value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new InvalidDocumentCommandError('line count must be a whole number');
  }
  if (value < 1) {
    throw new InvalidDocumentCommandError(
      `the ${operation} range must end at or after its first line ${String(target.lineNumber)}`,
    );
  }
  return value;
}

function parseReason(value: unknown): { readonly reason?: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string') throw new InvalidDocumentCommandError('reason must be a string');
  const reason = value.trim();
  return reason === '' ? {} : { reason };
}

function parseTarget(value: unknown): DocumentTarget {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidDocumentCommandError('target is required');
  }
  const fields = new Map(Object.entries(value));
  return createDocumentTarget(fields.get('lineNumber'), fields.get('lineText'));
}
