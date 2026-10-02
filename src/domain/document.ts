import { DocumentConflictError } from './errors';

export interface DocumentSnapshot {
  readonly lines: readonly string[];
}

export function createDocumentSnapshot(lines: readonly string[]): DocumentSnapshot {
  return Object.freeze({ lines: Object.freeze([...lines]) });
}

export function isSameDocument(first: DocumentSnapshot, second: DocumentSnapshot): boolean {
  return (
    first.lines.length === second.lines.length &&
    first.lines.every((line, index) => line === second.lines[index])
  );
}

export function assertSameDocument(expected: DocumentSnapshot, current: DocumentSnapshot): void {
  if (!isSameDocument(expected, current)) {
    throw new DocumentConflictError(
      'The document changed after the suggestion was made. Ask again to get a fresh suggestion.',
    );
  }
}
