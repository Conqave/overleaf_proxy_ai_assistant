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

export const MIN_QUOTED_START = 20;

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

function isQuotedStartOf(line: string, quoted: string): boolean {
  const full = normalize(line);
  const start = normalize(quoted);
  return full.startsWith(start) && start.length >= Math.min(MIN_QUOTED_START, full.length);
}

export function findLinesStartingWith(snapshot: DocumentSnapshot, quoted: string): number[] {
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
    throw new DocumentTargetNotFoundError(
      `Line ${String(requested.lineNumber)} does not start with "${requested.lineText}".`,
    );
  }
  return Object.freeze({ lineNumber: requested.lineNumber, lineText: atNumber });
}
