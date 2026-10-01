import type { DocumentSnapshot } from './document';
import { DocumentTargetNotFoundError, InvalidDocumentCommandError } from './errors';

export interface DocumentTarget {
  readonly lineNumber: number;
  readonly lineText: string;
}

export function createDocumentTarget(lineNumber: unknown, lineText: unknown): DocumentTarget {
  if (typeof lineNumber !== 'number' || !Number.isInteger(lineNumber) || lineNumber < 1) {
    throw new InvalidDocumentCommandError('target line must be a positive integer');
  }
  if (typeof lineText !== 'string') {
    throw new InvalidDocumentCommandError('target text must be a string');
  }
  if (lineText.includes('\n')) {
    throw new InvalidDocumentCommandError('target text must be a single line');
  }
  return Object.freeze({ lineNumber, lineText });
}

const MIN_QUOTED_START = 20;
const NEARBY_LINES = 2;

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

function isQuotedStartOf(line: string, quoted: string): boolean {
  const full = normalize(line);
  const start = normalize(quoted);
  return full.startsWith(start) && start.length >= Math.min(MIN_QUOTED_START, full.length);
}

function findLinesStartingWith(snapshot: DocumentSnapshot, quoted: string): number[] {
  if (normalize(quoted) === '') return [];
  return snapshot.lines.flatMap((line, index) =>
    isQuotedStartOf(line, quoted) ? [index + 1] : [],
  );
}

export function resolveTarget(
  snapshot: DocumentSnapshot,
  requested: DocumentTarget,
): DocumentTarget {
  const atNumber = snapshot.lines[requested.lineNumber - 1];
  if (atNumber === undefined || !isQuotedStartOf(atNumber, requested.lineText)) {
    throw new DocumentTargetNotFoundError(describeMismatch(snapshot, requested));
  }
  return Object.freeze({ lineNumber: requested.lineNumber, lineText: atNumber });
}

function describeMismatch(snapshot: DocumentSnapshot, requested: DocumentTarget): string {
  const { lineNumber, lineText } = requested;
  const actual = snapshot.lines[lineNumber - 1];
  if (actual === undefined) {
    return `Line ${String(lineNumber)} does not exist; the document has ${String(snapshot.lines.length)} lines.`;
  }
  const content = actual.trim() === '' ? 'is an empty line' : `reads: ${actual}`;
  const [quotedLine, ...others] = findLinesStartingWith(snapshot, lineText);
  if (quotedLine !== undefined && others.length === 0) {
    return `The quoted text starts line ${String(quotedLine)}, not line ${String(lineNumber)}, which ${content}. The lines around line ${String(lineNumber)} are:\n${describeNearbyLines(snapshot, lineNumber)}`;
  }
  return `Line ${String(lineNumber)} does not start with the quoted text; it ${content}. Quote the start of the line: at least ${String(MIN_QUOTED_START)} characters, or the whole line if it is shorter.`;
}

function describeNearbyLines(snapshot: DocumentSnapshot, lineNumber: number): string {
  const first = Math.max(1, lineNumber - NEARBY_LINES);
  return snapshot.lines
    .slice(first - 1, lineNumber + NEARBY_LINES)
    .map((text, index) => `${String(first + index)}: ${text}`)
    .join('\n');
}
