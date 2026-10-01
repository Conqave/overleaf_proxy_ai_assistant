import { describe, expect, it } from 'vitest';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { InvalidToolCallError, ReadRangeError } from '../../../src/domain/errors';
import {
  createReadRange,
  getReadSpan,
  isSameReadRange,
  numberLine,
  READ_LIMITS,
} from '../../../src/domain/read-window';

const numbered = (count: number, text = 'x') =>
  createDocumentSnapshot(Array.from({ length: count }, () => text));

describe('createReadRange', () => {
  it('reads the whole file when no line is given', () => {
    expect(createReadRange(undefined, undefined)).toBeUndefined();
  });

  it('starts at the first line when only the end is given', () => {
    expect(createReadRange(undefined, 40)).toEqual({ startLine: 1, endLine: 40 });
    expect(createReadRange(30, undefined)).toEqual({ startLine: 30 });
    expect(createReadRange(30, 30)).toEqual({ startLine: 30, endLine: 30 });
  });

  it.each([
    ['a zero start', 0, undefined],
    ['a fractional end', 1, 2.5],
    ['a text start', '3', undefined],
    ['an end before the start', 9, 3],
  ])('rejects %s', (_name, start, end) => {
    expect(() => createReadRange(start, end)).toThrow(InvalidToolCallError);
  });

  it('compares ranges by their lines', () => {
    expect(isSameReadRange(undefined, undefined)).toBe(true);
    expect(isSameReadRange({ startLine: 1 }, undefined)).toBe(false);
    expect(isSameReadRange({ startLine: 1, endLine: 5 }, { startLine: 1, endLine: 5 })).toBe(true);
    expect(isSameReadRange({ startLine: 1, endLine: 5 }, { startLine: 1 })).toBe(false);
  });
});

describe('getReadSpan', () => {
  it('shows a short file whole', () => {
    expect(getReadSpan(numbered(30), undefined)).toEqual({ first: 1, last: 30 });
  });

  it('shows the requested lines and stops at the end of the file', () => {
    expect(getReadSpan(numbered(30), { startLine: 10, endLine: 12 })).toEqual({
      first: 10,
      last: 12,
    });
    expect(getReadSpan(numbered(30), { startLine: 25, endLine: 90 })).toEqual({
      first: 25,
      last: 30,
    });
  });

  it('shows at most the line limit', () => {
    expect(getReadSpan(numbered(5_000), { startLine: 101 })).toEqual({
      first: 101,
      last: 100 + READ_LIMITS.maxLines,
    });
  });

  it('shows at most the character limit of numbered lines', () => {
    const line = 'y'.repeat(995);
    const span = getReadSpan(numbered(100, line), undefined);
    const shownChars = (span.last - span.first + 1) * (numberLine(99, line).length + 1);
    expect(shownChars).toBeLessThanOrEqual(READ_LIMITS.maxChars);
    expect(shownChars + 1_000).toBeGreaterThan(READ_LIMITS.maxChars);
  });

  it('always shows the first requested line, however long', () => {
    const huge = createDocumentSnapshot(['z'.repeat(READ_LIMITS.maxChars * 2), 'next']);
    expect(getReadSpan(huge, undefined)).toEqual({ first: 1, last: 1 });
  });

  it('shows an empty file as empty', () => {
    expect(getReadSpan(createDocumentSnapshot([]), undefined)).toEqual({ first: 1, last: 0 });
  });

  it('rejects a start past the end of the file', () => {
    expect(() => getReadSpan(numbered(30), { startLine: 31 })).toThrow(
      new ReadRangeError('the file has 30 lines, so it has no line 31; read from a line up to 30'),
    );
  });
});
