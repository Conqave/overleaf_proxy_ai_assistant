import { describe, expect, it } from 'vitest';
import { createToolCall, isSameToolCall } from '../../../src/domain/agent-action';
import { InvalidToolCallError } from '../../../src/domain/errors';

describe('createToolCall', () => {
  it('accepts each tool with its own argument', () => {
    expect(createToolCall({ tool: 'read_file', path: 'chapters/intro.tex' })).toEqual({
      tool: 'read_file',
      path: 'chapters/intro.tex',
    });
    expect(createToolCall({ tool: 'search', query: '  \\label{fig:setup} ' })).toEqual({
      tool: 'search',
      query: '\\label{fig:setup}',
    });
    expect(createToolCall({ tool: 'compile' })).toEqual({ tool: 'compile' });
  });

  it('accepts a line range for read_file', () => {
    expect(createToolCall({ tool: 'read_file', path: 'a.tex', startLine: 5, endLine: 9 })).toEqual({
      tool: 'read_file',
      path: 'a.tex',
      range: { startLine: 5, endLine: 9 },
    });
  });

  it.each([
    ['an unknown tool', { tool: 'list_files' }],
    ['read_file without a path', { tool: 'read_file' }],
    ['an absolute path', { tool: 'read_file', path: '/main.tex' }],
    ['a parent path', { tool: 'read_file', path: '../secret.tex' }],
    ['an empty segment', { tool: 'read_file', path: 'a//b.tex' }],
    ['a multi-line path', { tool: 'read_file', path: 'a.tex\nb.tex' }],
    ['read_file with a query', { tool: 'read_file', path: 'a.tex', query: 'x' }],
    ['search without a query', { tool: 'search' }],
    ['a one-character query', { tool: 'search', query: ' x ' }],
    ['a too long query', { tool: 'search', query: 'x'.repeat(201) }],
    ['a multi-line query', { tool: 'search', query: 'ab\ncd' }],
    ['search with a path', { tool: 'search', query: 'abc', path: 'a.tex' }],
    ['compile with a path', { tool: 'compile', path: 'main.tex' }],
    [
      'read_file ending before it starts',
      { tool: 'read_file', path: 'a.tex', startLine: 9, endLine: 2 },
    ],
    ['search with a start line', { tool: 'search', query: 'abc', startLine: 2 }],
    ['compile with an end line', { tool: 'compile', endLine: 2 }],
  ])('rejects %s', (_name, input) => {
    expect(() => createToolCall(input)).toThrow(InvalidToolCallError);
  });
});

describe('isSameToolCall', () => {
  it('compares the tool and its argument', () => {
    const read = createToolCall({ tool: 'read_file', path: 'a.tex' });
    expect(isSameToolCall(read, createToolCall({ tool: 'read_file', path: 'a.tex' }))).toBe(true);
    expect(isSameToolCall(read, createToolCall({ tool: 'read_file', path: 'b.tex' }))).toBe(false);
    expect(
      isSameToolCall(read, createToolCall({ tool: 'read_file', path: 'a.tex', startLine: 3 })),
    ).toBe(false);
    expect(isSameToolCall(read, createToolCall({ tool: 'search', query: 'a.tex' }))).toBe(false);
    expect(isSameToolCall({ tool: 'compile' }, { tool: 'compile' })).toBe(true);
  });
});
