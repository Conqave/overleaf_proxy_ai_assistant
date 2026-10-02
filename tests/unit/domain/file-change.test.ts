import { describe, expect, it } from 'vitest';
import { createDocumentSnapshot, type DocumentSnapshot } from '../../../src/domain/document';
import {
  createDocumentCommand,
  type DocumentCommandInput,
} from '../../../src/domain/document-command';
import {
  InvariantViolation,
  OverlappingEditsError,
  UndoConflictError,
} from '../../../src/domain/errors';
import {
  checkSeparateEdits,
  planEditChange,
  planUndo,
  rebaseEdit,
  type AppliedSplice,
  type EditChange,
} from '../../../src/domain/file-change';
import { ResolvedEdit } from '../../../src/domain/resolved-edit';
import { itemAt } from '../../support/guards';

const LINES = ['one', 'two', 'three', 'four', 'five', 'six'];
const document = createDocumentSnapshot(LINES);

type Operation = DocumentCommandInput['operation'];

function edit(
  operation: Operation,
  lineNumber: number,
  extra: Omit<DocumentCommandInput, 'operation' | 'target'> = {},
  base: DocumentSnapshot = document,
): ResolvedEdit {
  const lineText = itemAt(base.lines, lineNumber - 1, 'line');
  return ResolvedEdit.resolve(
    base,
    createDocumentCommand({ operation, target: { lineNumber, lineText }, ...extra }),
  );
}

const replace = (line: number, content: string, lineCount = 1) =>
  edit('replace', line, { content, lineCount });
const remove = (line: number, lineCount = 1, base = document) =>
  edit('delete', line, { lineCount }, base);
const insertAfter = (line: number, content: string) => edit('insert_after', line, { content });
const insertBefore = (line: number, content: string) => edit('insert_before', line, { content });

function undoAll(path: string, current: DocumentSnapshot, change: EditChange) {
  const undoOrder = [...change.applied].reverse().map(({ applied }) => applied);
  return planUndo(path, current, undoOrder);
}

describe('ResolvedEdit.splice', () => {
  it('turns each operation into the lines it removes and inserts', () => {
    expect(insertBefore(2, 'a\nb').splice).toEqual({ line: 2, removed: [], inserted: ['a', 'b'] });
    expect(insertAfter(2, 'a').splice).toEqual({ line: 3, removed: [], inserted: ['a'] });
    expect(replace(2, 'x', 2).splice).toEqual({
      line: 2,
      removed: ['two', 'three'],
      inserted: ['x'],
    });
    expect(remove(5, 2).splice).toEqual({ line: 5, removed: ['five', 'six'], inserted: [] });
  });

  it('leaves one empty line when the whole document is deleted, as the editor does', () => {
    expect(remove(1, 6).splice).toEqual({ line: 1, removed: LINES, inserted: [''] });
  });
});

describe('planEditChange', () => {
  it('applies the edits bottom-up so every line number stays valid', () => {
    const { change, applied } = planEditChange([
      replace(1, 'ONE'),
      insertAfter(3, 'after three'),
      remove(5),
    ]);
    expect(applied.map(({ index }) => index)).toEqual([2, 1, 0]);
    expect(change.splices).toEqual([
      { line: 1, removed: ['one'], inserted: ['ONE'] },
      { line: 4, removed: [], inserted: ['after three'] },
      { line: 5, removed: ['five'], inserted: [] },
    ]);
    expect(change.after.lines).toEqual(['ONE', 'two', 'three', 'after three', 'four', 'six']);
    expect(change.before).toBe(document);
  });

  it('records each applied edit in application order with the lines it replaced', () => {
    const { applied } = planEditChange([replace(1, 'ONE'), insertAfter(3, 'x\ny')]);
    expect(applied).toEqual([
      { index: 1, applied: { line: 4, before: [], after: ['x', 'y'] } },
      { index: 0, applied: { line: 1, before: ['one'], after: ['ONE'] } },
    ]);
  });

  it('keeps the following line with a deletion so its undo can check the place', () => {
    expect(planEditChange([remove(2, 2)]).applied).toEqual([
      { index: 0, applied: { line: 2, before: ['two', 'three', 'four'], after: ['four'] } },
    ]);
    expect(planEditChange([remove(5, 2)]).applied).toEqual([
      { index: 0, applied: { line: 4, before: ['four', 'five', 'six'], after: ['four'] } },
    ]);
  });

  it('refuses edits made for different documents or overlapping each other', () => {
    const other = createDocumentSnapshot(['one', 'two']);
    expect(() => planEditChange([remove(1), remove(2, 1, other)])).toThrow(InvariantViolation);
    expect(() => planEditChange([remove(1), replace(1, 'x')])).toThrow(InvariantViolation);
    expect(() => planEditChange([])).toThrow(InvariantViolation);
  });
});

describe('checkSeparateEdits', () => {
  const inMain = (...edits: ResolvedEdit[]) => edits.map((e) => ({ path: 'main.tex', edit: e }));

  it('accepts edits of different lines and of different files', () => {
    expect(() => {
      checkSeparateEdits(inMain(replace(1, 'x'), insertAfter(2, 'y'), remove(4, 3)));
    }).not.toThrow();
    expect(() => {
      checkSeparateEdits([
        { path: 'main.tex', edit: replace(2, 'x') },
        { path: 'refs.bib', edit: replace(2, 'y') },
      ]);
    }).not.toThrow();
  });

  it.each([
    ['two replacements of one line', [replace(2, 'x'), replace(2, 'y')]],
    ['a range that covers another edit', [insertAfter(4, 'x'), remove(3, 3)]],
    ['an insertion after a replaced line', [replace(3, 'x'), insertAfter(3, 'y')]],
    ['two insertions at the same place', [insertAfter(2, 'x'), insertBefore(3, 'y')]],
  ])('rejects %s within one file', (_name, edits) => {
    expect(() => {
      checkSeparateEdits(inMain(...edits));
    }).toThrow(OverlappingEditsError);
  });

  it('names both edits and the line in its message', () => {
    expect(() => {
      checkSeparateEdits(inMain(replace(1, 'a'), remove(4, 2), replace(5, 'x')));
    }).toThrow(
      new OverlappingEditsError(
        'edits 2 and 3 both change main.tex at or next to line 4; send one edit for those lines instead of two',
      ),
    );
  });
});

describe('rebaseEdit', () => {
  it('moves a later edit by the lines the applied change added or removed above it', () => {
    const applied = planEditChange([insertAfter(1, 'a\nb'), remove(6)]);
    const rebased = rebaseEdit(replace(4, 'FOUR'), applied);
    expect(rebased.document).toBe(applied.change.after);
    expect(rebased.command.target).toEqual({ lineNumber: 6, lineText: 'four' });
    expect(rebased.splice).toEqual({ line: 6, removed: ['four'], inserted: ['FOUR'] });
  });

  it('refuses an edit made for another document', () => {
    const applied = planEditChange([remove(1)]);
    expect(() => rebaseEdit(remove(1, 1, applied.change.after), applied)).toThrow(
      InvariantViolation,
    );
  });
});

describe('planUndo', () => {
  it('restores the document from the applied edits taken back in reverse order', () => {
    const applied = planEditChange([replace(1, 'ONE'), insertAfter(3, 'x'), remove(5, 2)]);
    const undo = undoAll('main.tex', applied.change.after, applied);
    expect(undo.after.lines).toEqual(LINES);
    expect(undo.before).toBe(applied.change.after);
  });

  it('restores a document changed by two applies when the later one is undone first', () => {
    const first = planEditChange([insertAfter(5, 'late')]);
    const second = planEditChange([
      ResolvedEdit.resolve(
        first.change.after,
        createDocumentCommand({
          operation: 'delete',
          target: { lineNumber: 1, lineText: 'one' },
          lineCount: 2,
        }),
      ),
    ]);
    const undoOrder = [...first.applied, ...second.applied].map(({ applied }) => applied).reverse();
    expect(planUndo('main.tex', second.change.after, undoOrder).after.lines).toEqual(LINES);
  });

  it('undoes neighbouring edits as one splice of the document it starts from', () => {
    const applied = planEditChange([remove(2), replace(3, 'THREE')]);
    expect(applied.change.after.lines).toEqual(['one', 'THREE', 'four', 'five', 'six']);
    const undo = undoAll('main.tex', applied.change.after, applied);
    expect(undo.splices).toEqual([{ line: 2, removed: ['THREE'], inserted: ['two', 'three'] }]);
    expect(undo.after.lines).toEqual(LINES);
  });

  it('restores a document whose lines were all deleted', () => {
    const applied = planEditChange([remove(1, 6)]);
    expect(applied.change.after.lines).toEqual(['']);
    expect(undoAll('main.tex', applied.change.after, applied).after.lines).toEqual(LINES);
  });

  it('refuses when the written text is no longer in its place', () => {
    const applied = planEditChange([replace(2, 'TWO'), insertAfter(4, 'x\ny')]);
    const moved = createDocumentSnapshot(['new first line', ...applied.change.after.lines]);
    expect(() => undoAll('main.tex', moved, applied)).toThrow(
      new UndoConflictError(
        'main.tex changed after Hans edited it: line 2 no longer holds the text Hans wrote there, so this file was left as it is.',
      ),
    );
  });

  it('refuses a deletion whose following line changed', () => {
    const applied = planEditChange([remove(2, 2)]);
    const edited = createDocumentSnapshot(
      applied.change.after.lines.map((line) => (line === 'four' ? 'FOUR' : line)),
    );
    expect(() => undoAll('main.tex', edited, applied)).toThrow(UndoConflictError);
  });

  it('names a range of lines that changed', () => {
    const applied: AppliedSplice = { line: 2, before: ['b'], after: ['x', 'y'] };
    expect(() => planUndo('refs.bib', document, [applied])).toThrow(
      'refs.bib changed after Hans edited it: lines 2–3 no longer hold the text Hans wrote there',
    );
  });
});
