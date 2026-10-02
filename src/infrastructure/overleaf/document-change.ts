import type { ChangeSpec, Line, Text } from '@codemirror/state';
import { DocumentOperation, type DocumentCommand } from '../../domain/document-command';
import type { DocumentTarget } from '../../domain/document-target';
import { InvariantViolation } from '../../domain/errors';
import type { LineSplice } from '../../domain/file-change';

export interface AffectedLines {
  readonly first: Line;
  readonly last: Line;
}

export function getAffectedLines(doc: Text, command: DocumentCommand): AffectedLines {
  const first = getTargetLine(doc, command.target);
  switch (command.operation) {
    case DocumentOperation.InsertBefore:
    case DocumentOperation.InsertAfter:
      return { first, last: first };
    case DocumentOperation.Replace:
    case DocumentOperation.Delete: {
      const lastNumber = first.number + command.lineCount - 1;
      if (lastNumber > doc.lines) {
        throw new InvariantViolation(`the resolved range ends past line ${String(doc.lines)}`);
      }
      return { first, last: doc.line(lastNumber) };
    }
  }
}

export function createSpliceChange(doc: Text, splice: LineSplice): ChangeSpec {
  const { line, removed, inserted } = splice;
  if (removed.length === 0) {
    if (line <= doc.lines) return { from: doc.line(line).from, insert: `${inserted.join('\n')}\n` };
    if (line === doc.lines + 1) return { from: doc.length, insert: `\n${inserted.join('\n')}` };
    throw new InvariantViolation(`the document has no line ${String(line)} to insert at`);
  }
  const lastNumber = line + removed.length - 1;
  if (lastNumber > doc.lines) {
    throw new InvariantViolation(`the removed lines end past line ${String(doc.lines)}`);
  }
  const first = doc.line(line);
  const last = doc.line(lastNumber);
  if (doc.sliceString(first.from, last.to) !== removed.join('\n')) {
    throw new InvariantViolation(
      `lines ${String(line)}–${String(lastNumber)} are not the removed lines`,
    );
  }
  if (inserted.length) return { from: first.from, to: last.to, insert: inserted.join('\n') };
  return createLinesRemoval(doc, first, last);
}

function getTargetLine(doc: Text, target: DocumentTarget): Line {
  const { lineNumber, lineText } = target;
  const line = lineNumber <= doc.lines ? doc.line(lineNumber) : null;
  if (line?.text !== lineText) {
    throw new InvariantViolation(`line ${String(lineNumber)} is not the resolved target`);
  }
  return line;
}

function createLinesRemoval(doc: Text, first: Line, last: Line): ChangeSpec {
  if (last.number < doc.lines) return { from: first.from, to: last.to + 1 };
  if (first.number > 1) return { from: first.from - 1, to: last.to };
  return { from: first.from, to: last.to };
}
