import type { DocumentSnapshot } from './document';
import { InvalidToolCallError, InvariantViolation, ReadRangeError } from './errors';

export interface ReadRange {
  readonly startLine: number;
  readonly endLine?: number;
}

export interface LineSpan {
  readonly first: number;
  readonly last: number;
}

export const READ_LIMITS = { maxLines: 2_000, maxChars: 16_000 } as const;

const LINE_BREAK_CHARS = 1;

export function numberLine(lineNumber: number, text: string): string {
  return `${String(lineNumber)}: ${text}`;
}

export function createReadRange(startLine: unknown, endLine: unknown): ReadRange | undefined {
  if (startLine === undefined && endLine === undefined) return undefined;
  const first = startLine === undefined ? 1 : parseLineNumber('the start line', startLine);
  if (endLine === undefined) return Object.freeze({ startLine: first });
  const last = parseLineNumber('the end line', endLine);
  if (last < first) {
    throw new InvalidToolCallError(
      `the end line ${String(last)} comes before the start line ${String(first)}`,
    );
  }
  return Object.freeze({ startLine: first, endLine: last });
}

export function isSameReadRange(
  first: ReadRange | undefined,
  second: ReadRange | undefined,
): boolean {
  return first?.startLine === second?.startLine && first?.endLine === second?.endLine;
}

export function getReadSpan(document: DocumentSnapshot, range: ReadRange | undefined): LineSpan {
  const total = document.lines.length;
  const first = range?.startLine ?? 1;
  if (first > Math.max(total, 1)) {
    throw new ReadRangeError(
      `the file has ${String(total)} lines, so it has no line ${String(first)}; read from a line up to ${String(total)}`,
    );
  }
  const requestedLast = Math.min(range?.endLine ?? total, total, first + READ_LIMITS.maxLines - 1);
  let last = first - 1;
  let chars = 0;
  while (last < requestedLast) {
    const text = document.lines[last];
    if (text === undefined)
      throw new InvariantViolation(`the document has no line ${String(last + 1)}`);
    chars += numberLine(last + 1, text).length + LINE_BREAK_CHARS;
    if (chars > READ_LIMITS.maxChars && last >= first) break;
    last += 1;
  }
  return Object.freeze({ first, last });
}

function parseLineNumber(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new InvalidToolCallError(`${name} must be a line number from 1`);
  }
  return value;
}
