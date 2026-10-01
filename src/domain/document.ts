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
