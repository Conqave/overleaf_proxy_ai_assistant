import { createDocumentSnapshot, isSameDocument, type DocumentSnapshot } from './document';
import { getCommandLines } from './document-command';
import {
  DocumentTargetNotFoundError,
  InvariantViolation,
  OverlappingEditsError,
  UndoConflictError,
} from './errors';
import type { LineSpan } from './read-window';
import { ResolvedEdit } from './resolved-edit';

export interface LineSplice {
  readonly line: number;
  readonly removed: readonly string[];
  readonly inserted: readonly string[];
}

export interface FileChange {
  readonly before: DocumentSnapshot;
  readonly splices: readonly LineSplice[];
  readonly after: DocumentSnapshot;
}

export interface AppliedSplice {
  readonly line: number;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export interface AppliedEdit {
  readonly index: number;
  readonly applied: AppliedSplice;
}

export interface EditChange {
  readonly change: FileChange;
  readonly applied: readonly AppliedEdit[];
}

interface PathEdit {
  readonly path: string;
  readonly edit: ResolvedEdit;
}

export function checkSeparateEdits(edits: readonly PathEdit[]): void {
  const overlap = findOverlap(edits);
  if (overlap === null) return;
  const [first, second] = overlap;
  const { path, edit } = itemAt(edits, first);
  const line = getCommandLines(edit.command).first;
  throw new OverlappingEditsError(
    `edits ${String(first + 1)} and ${String(second + 1)} both change ${path} at or next to line ${String(line)}; send one edit for those lines instead of two`,
  );
}

export function planEditChange(edits: readonly ResolvedEdit[]): EditChange {
  const [first] = edits;
  if (first === undefined) throw new InvariantViolation('a file change needs at least one edit');
  if (!edits.every((edit) => isSameDocument(edit.document, first.document))) {
    throw new InvariantViolation('the edits of one file change were made for different documents');
  }
  if (findOverlap(edits.map((edit) => ({ path: '', edit }))) !== null) {
    throw new InvariantViolation('the edits of one file change overlap');
  }
  const bottomUp = edits
    .map((edit, index) => ({ index, splice: edit.splice }))
    .sort((a, b) => b.splice.line - a.splice.line);
  const lines = [...first.document.lines];
  const applied = bottomUp.map(({ index, splice }) => {
    applySplice(lines, splice);
    return { index, applied: captureApplied(lines, splice) };
  });
  return {
    change: composeSplices(
      first.document,
      bottomUp.map(({ splice }) => splice),
    ),
    applied,
  };
}

export function rebaseEdit(edit: ResolvedEdit, { change }: EditChange): ResolvedEdit {
  if (!isSameDocument(edit.document, change.before)) {
    throw new InvariantViolation(
      'an edit can only follow a change of the document it was made for',
    );
  }
  const position = edit.splice.line;
  const shift = change.splices
    .filter((splice) => splice.line < position)
    .reduce((total, splice) => total + splice.inserted.length - splice.removed.length, 0);
  const { target } = edit.command;
  try {
    return ResolvedEdit.resolve(change.after, {
      ...edit.command,
      target: { ...target, lineNumber: target.lineNumber + shift },
    });
  } catch (error) {
    if (!(error instanceof DocumentTargetNotFoundError)) throw error;
    throw new InvariantViolation('a separate edit lost its target in the changed document', {
      cause: error,
    });
  }
}

export function planUndo(
  path: string,
  document: DocumentSnapshot,
  undoOrder: readonly AppliedSplice[],
): FileChange {
  const lines = [...document.lines];
  const steps = undoOrder.map((applied) => {
    const start = applied.line - 1;
    const current = lines.slice(start, start + applied.after.length);
    if (!isSameLines(current, applied.after)) {
      throw new UndoConflictError(
        `${path} changed after Hans edited it: ${describeLines(applied)} the text Hans wrote there, so this file was left as it is.`,
      );
    }
    const step = { line: applied.line, removed: applied.after, inserted: applied.before };
    applySplice(lines, step);
    return step;
  });
  return composeSplices(document, steps);
}

interface TracedLine {
  readonly text: string;
  readonly base: number | null;
}

function composeSplices(before: DocumentSnapshot, steps: readonly LineSplice[]): FileChange {
  const traced: TracedLine[] = before.lines.map((text, base) => ({ text, base }));
  for (const step of steps) {
    const start = step.line - 1;
    const removed = traced.slice(start, start + step.removed.length).map(({ text }) => text);
    if (start > traced.length || !isSameLines(removed, step.removed)) {
      throw new InvariantViolation(`the lines removed at line ${String(step.line)} are not there`);
    }
    const inserted = step.inserted.map((text) => ({ text, base: null }));
    traced.splice(start, step.removed.length, ...inserted);
  }
  return {
    before,
    splices: findBaseSplices(before, traced),
    after: createDocumentSnapshot(traced.map(({ text }) => text)),
  };
}

function findBaseSplices(before: DocumentSnapshot, traced: readonly TracedLine[]): LineSplice[] {
  const splices: LineSplice[] = [];
  let nextBase = 0;
  let inserted: string[] = [];
  const close = (keptBase: number): void => {
    if (keptBase > nextBase || inserted.length) {
      splices.push({
        line: nextBase + 1,
        removed: before.lines.slice(nextBase, keptBase),
        inserted,
      });
    }
    inserted = [];
    nextBase = keptBase + 1;
  };
  for (const { text, base } of traced) {
    if (base === null) inserted.push(text);
    else close(base);
  }
  close(before.lines.length);
  return splices;
}

function findOverlap(edits: readonly PathEdit[]): readonly [number, number] | null {
  for (let second = 1; second < edits.length; second += 1) {
    for (let first = 0; first < second; first += 1) {
      if (isOverlapping(itemAt(edits, first), itemAt(edits, second))) return [first, second];
    }
  }
  return null;
}

function isOverlapping(first: PathEdit, second: PathEdit): boolean {
  if (first.path !== second.path) return false;
  const a = getCommandLines(first.edit.command);
  const b = getCommandLines(second.edit.command);
  return isIntersecting(a, b) || first.edit.splice.line === second.edit.splice.line;
}

function isIntersecting(a: LineSpan, b: LineSpan): boolean {
  return a.first <= b.last && b.first <= a.last;
}

function applySplice(lines: string[], splice: LineSplice): void {
  const start = splice.line - 1;
  if (start < 0 || start > lines.length) {
    throw new InvariantViolation(
      `a document of ${String(lines.length)} lines has no line ${String(splice.line)}`,
    );
  }
  if (!isSameLines(lines.slice(start, start + splice.removed.length), splice.removed)) {
    throw new InvariantViolation(
      `the lines removed at line ${String(splice.line)} are not in the document`,
    );
  }
  lines.splice(start, splice.removed.length, ...splice.inserted);
}

function captureApplied(lines: readonly string[], splice: LineSplice): AppliedSplice {
  const { line, removed, inserted } = splice;
  if (inserted.length) return { line, before: removed, after: inserted };
  const following = lines[line - 1];
  if (following !== undefined) {
    return { line, before: [...removed, following], after: [following] };
  }
  const preceding = lines[line - 2];
  if (preceding === undefined) throw new InvariantViolation('a deletion emptied the document');
  return { line: line - 1, before: [preceding, ...removed], after: [preceding] };
}

function isSameLines(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((line, index) => line === second[index]);
}

function describeLines({ line, after }: AppliedSplice): string {
  if (after.length === 1) return `line ${String(line)} no longer holds`;
  return `lines ${String(line)}–${String(line + after.length - 1)} no longer hold`;
}

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new InvariantViolation(`no item ${String(index)}`);
  return item;
}
