import type { ChangeSpec, Line, Text } from '@codemirror/state';
import { DocumentOperation, type DocumentCommand } from '../../domain/document-command';
import type { DocumentTarget } from '../../domain/document-target';
import { InvariantViolation } from '../../domain/errors';

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

export function createChange(doc: Text, command: DocumentCommand): ChangeSpec {
  const { first, last } = getAffectedLines(doc, command);
  switch (command.operation) {
    case DocumentOperation.InsertBefore:
      return { from: first.from, insert: `${command.content}\n` };
    case DocumentOperation.InsertAfter:
      return { from: first.to, insert: `\n${command.content}` };
    case DocumentOperation.Replace:
      return { from: first.from, to: last.to, insert: command.content };
    case DocumentOperation.Delete:
      return createLinesRemoval(doc, first, last);
  }
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
