import { describe, expect, it } from 'vitest';
import { createDocumentSnapshot } from '../../../src/domain/document';
import {
  assertSnapshotCurrent,
  createDocumentTarget,
  resolveTarget,
} from '../../../src/domain/document-target';
import { DocumentConflictError, DocumentTargetNotFoundError } from '../../../src/domain/errors';

const snapshot = createDocumentSnapshot([
  '\\section{A}',
  'Text  one.',
  '',
  '\\section{B}',
  'dup',
  'dup',
]);

describe('resolveTarget', () => {
  it('accepts a line whose number and text agree (whitespace-insensitive)', () => {
    expect(resolveTarget(snapshot, createDocumentTarget(2, 'Text one.'))).toEqual({
      lineNumber: 2,
      lineText: 'Text  one.',
    });
  });

  it('accepts an empty line addressed by number', () => {
    expect(resolveTarget(snapshot, createDocumentTarget(3, ''))).toEqual({
      lineNumber: 3,
      lineText: '',
    });
  });

  it('never moves to another line with the same text when the number is off', () => {
    expect(() => resolveTarget(snapshot, createDocumentTarget(1, '\\section{B}'))).toThrow(
      DocumentTargetNotFoundError,
    );
  });

  it('fails when the text does not exist', () => {
    expect(() => resolveTarget(snapshot, createDocumentTarget(1, 'missing'))).toThrow(
      DocumentTargetNotFoundError,
    );
  });

  it('accepts the quoted start of a long line and returns the whole line', () => {
    const long = createDocumentSnapshot([
      'Track changes are available on all plans. They record every edit.',
    ]);
    expect(
      resolveTarget(long, createDocumentTarget(1, 'Track changes are available on all plans.')),
    ).toEqual({
      lineNumber: 1,
      lineText: 'Track changes are available on all plans. They record every edit.',
    });
  });

  it('requires at least 20 quoted characters of a long line', () => {
    const long = createDocumentSnapshot(['Track changes are available on all plans.']);
    expect(() => resolveTarget(long, createDocumentTarget(1, 'Track'))).toThrow(
      DocumentTargetNotFoundError,
    );
  });

  it('does not fall back to substring matches', () => {
    expect(() => resolveTarget(snapshot, createDocumentTarget(9, 'section{A'))).toThrow(
      DocumentTargetNotFoundError,
    );
  });

  it('fails for an empty line number outside the document', () => {
    expect(() => resolveTarget(snapshot, createDocumentTarget(99, ''))).toThrow(
      DocumentTargetNotFoundError,
    );
  });
});

describe('assertSnapshotCurrent', () => {
  it('accepts the same content and rejects any change', () => {
    const same = createDocumentSnapshot([...snapshot.lines]);
    const changed = createDocumentSnapshot([...snapshot.lines.slice(0, -1), 'dup!']);
    expect(() => {
      assertSnapshotCurrent(snapshot, same);
    }).not.toThrow();
    expect(() => {
      assertSnapshotCurrent(snapshot, changed);
    }).toThrow(DocumentConflictError);
  });

  it('distinguishes line splits from joins', () => {
    expect(() => {
      assertSnapshotCurrent(createDocumentSnapshot(['a', 'b']), createDocumentSnapshot(['a\nb']));
    }).toThrow(DocumentConflictError);
  });
});
