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
  ])('rejects %s', (_name, input) => {
    expect(() => createToolCall(input)).toThrow(InvalidToolCallError);
  });
});

describe('isSameToolCall', () => {
  it('compares the tool and its argument', () => {
    const read = createToolCall({ tool: 'read_file', path: 'a.tex' });
    expect(isSameToolCall(read, createToolCall({ tool: 'read_file', path: 'a.tex' }))).toBe(true);
    expect(isSameToolCall(read, createToolCall({ tool: 'read_file', path: 'b.tex' }))).toBe(false);
    expect(isSameToolCall(read, createToolCall({ tool: 'search', query: 'a.tex' }))).toBe(false);
    expect(isSameToolCall({ tool: 'compile' }, { tool: 'compile' })).toBe(true);
  });
});
