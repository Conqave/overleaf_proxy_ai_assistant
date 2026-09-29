import { describe, expect, it } from 'vitest';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { InvalidDocumentCommandError } from '../../../src/domain/errors';

const target = { lineNumber: 3, lineText: '\\section{Introduction}' };

describe('createDocumentCommand', () => {
  it.each(['insert_before', 'insert_after'] as const)('accepts a valid %s', (operation) => {
    const command = createDocumentCommand({ operation, target, content: 'Text.', reason: ' r ' });
    expect(command).toEqual({ operation, target, content: 'Text.', reason: 'r' });
  });

  it('accepts a replace of a line range', () => {
    const command = createDocumentCommand({
      operation: 'replace',
      target,
      lineCount: 3,
      content: 'Text.',
    });
    expect(command).toEqual({
      operation: 'replace',
      target,
      lineCount: 3,
      content: 'Text.',
    });
  });

  it('accepts a delete of a line range', () => {
    expect(createDocumentCommand({ operation: 'delete', target, lineCount: 2 })).toEqual({
      operation: 'delete',
      target,
      lineCount: 2,
    });
  });

  it('reads a range without a line count as the target line alone', () => {
    expect(createDocumentCommand({ operation: 'delete', target })).toMatchObject({ lineCount: 1 });
  });

  it('keeps multi-line content verbatim', () => {
    const content = '\\begin{itemize}\n  \\item a\n\\end{itemize}';
    const command = createDocumentCommand({ operation: 'insert_after', target, content });
    expect(command).toMatchObject({ content });
  });

  it.each([
    ['missing target', { operation: 'replace', lineCount: 1, content: 'x' }],
    ['replace with zero lines', { operation: 'replace', target, lineCount: 0, content: 'x' }],
    ['range ending before it starts', { operation: 'delete', target, lineCount: -1 }],
    ['fractional line count', { operation: 'delete', target, lineCount: 1.5 }],
    [
      'insertion with a line count',
      { operation: 'insert_after', target, lineCount: 2, content: 'x' },
    ],
    ['null target', { operation: 'delete', lineCount: 1, target: null }],
    ['missing content', { operation: 'insert_after', target }],
    ['blank content', { operation: 'replace', target, content: '   ' }],
    ['non-string content', { operation: 'insert_before', target, content: 42 }],
    ['unexpected content', { operation: 'delete', lineCount: 1, target, content: 'x' }],
    ['unknown operation', { operation: 'explain', target, content: 'x' }],
    ['legacy operation name', { operation: 'replace_line', target, content: 'x' }],
    ['zero line', { operation: 'delete', lineCount: 1, target: { lineNumber: 0, lineText: 'a' } }],
    [
      'fractional line',
      { operation: 'delete', lineCount: 1, target: { lineNumber: 1.5, lineText: 'a' } },
    ],
    [
      'string line',
      { operation: 'delete', lineCount: 1, target: { lineNumber: '1', lineText: 'a' } },
    ],
    ['missing target text', { operation: 'delete', lineCount: 1, target: { lineNumber: 1 } }],
    [
      'multi-line target text',
      { operation: 'delete', lineCount: 1, target: { lineNumber: 1, lineText: 'a\nb' } },
    ],
    ['non-string reason', { operation: 'delete', lineCount: 1, target, reason: 1 }],
  ])('rejects %s', (_name, input) => {
    expect(() => createDocumentCommand(input)).toThrow(InvalidDocumentCommandError);
  });

  it('produces immutable commands', () => {
    const command = createDocumentCommand({ operation: 'delete', lineCount: 1, target });
    expect(Object.isFrozen(command)).toBe(true);
  });
});
