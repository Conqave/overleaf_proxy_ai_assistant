import { describe, expect, it } from 'vitest';
import {
  canUndoEdits,
  checkEditCount,
  createChangeSet,
  decideEdits,
  getUndoOrder,
  recordAppliedEdits,
  recordUndoneEdits,
  MAX_EDITS_PER_CHANGE,
  restoreChangeSet,
} from '../../../src/domain/change-set';
import { createDocumentCommand } from '../../../src/domain/document-command';
import {
  InvalidChangeSetError,
  InvariantViolation,
  TooManyEditsError,
} from '../../../src/domain/errors';

const request = (path: string, lineNumber: number) => ({
  path,
  command: createDocumentCommand({
    operation: 'delete',
    target: { lineNumber, lineText: 'x' },
  }),
});
const applied = (line: number) => ({ line, before: ['x', 'y'], after: ['y'] });

describe('change sets', () => {
  it('holds at least one proposed edit', () => {
    expect(createChangeSet([request('a.tex', 1)])).toEqual([
      { ...request('a.tex', 1), status: 'proposed' },
    ]);
    expect(() => createChangeSet([])).toThrow(InvalidChangeSetError);
  });

  it('lets the agent propose at most the maximum of edits in one change', () => {
    expect(() => {
      checkEditCount(MAX_EDITS_PER_CHANGE);
    }).not.toThrow();
    expect(() => {
      checkEditCount(MAX_EDITS_PER_CHANGE + 1);
    }).toThrow(TooManyEditsError);
  });

  it('numbers applied edits in the order they were applied, across applies', () => {
    const proposed = createChangeSet([
      request('a.tex', 1),
      request('a.tex', 5),
      request('b.tex', 2),
    ]);
    const first = recordAppliedEdits(proposed, [
      { index: 1, applied: applied(5) },
      { index: 0, applied: applied(1) },
    ]);
    const second = recordAppliedEdits(first, [{ index: 2, applied: applied(2) }]);
    expect(
      second.map((edit) => (edit.status === 'applied' ? edit.applied.sequence : null)),
    ).toEqual([1, 0, 2]);
    expect(() => recordAppliedEdits(second, [{ index: 0, applied: applied(1) }])).toThrow(
      InvariantViolation,
    );
  });

  it('gives the undo order of a file from the last applied edit back', () => {
    const edits = recordAppliedEdits(
      createChangeSet([request('a.tex', 1), request('a.tex', 5), request('b.tex', 2)]),
      [
        { index: 0, applied: applied(1) },
        { index: 2, applied: applied(2) },
        { index: 1, applied: applied(5) },
      ],
    );
    expect(getUndoOrder(edits, 'a.tex').map(({ index }) => index)).toEqual([1, 0]);
    expect(recordUndoneEdits(edits, [0, 1]).map(({ status }) => status)).toEqual([
      'undone',
      'undone',
      'applied',
    ]);
    expect(() => recordUndoneEdits(createChangeSet([request('a.tex', 1)]), [0])).toThrow(
      InvariantViolation,
    );
  });

  it('can be undone once something is applied and nothing is open', () => {
    const proposed = createChangeSet([request('a.tex', 1), request('a.tex', 5)]);
    const one = recordAppliedEdits(proposed, [{ index: 0, applied: applied(1) }]);
    expect(canUndoEdits(proposed)).toBe(false);
    expect(canUndoEdits(one)).toBe(false);
    expect(canUndoEdits(decideEdits(one, [1], 'rejected'))).toBe(true);
    expect(canUndoEdits(decideEdits(proposed, [0, 1], 'rejected'))).toBe(false);
  });

  it('refuses a stored change whose applied edits share a sequence number', () => {
    const edit = {
      ...request('a.tex', 1),
      status: 'applied' as const,
      applied: { ...applied(1), sequence: 0 },
    };
    expect(() => restoreChangeSet([edit, edit])).toThrow(InvalidChangeSetError);
  });

  it('restores a stored change of any size, but not an empty one', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...request('a.tex', i + 1),
      status: 'rejected' as const,
    }));
    expect(restoreChangeSet(many)).toEqual(many);
    expect(() => restoreChangeSet([])).toThrow(InvalidChangeSetError);
  });
});
