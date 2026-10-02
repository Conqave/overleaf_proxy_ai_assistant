import { describe, expect, it } from 'vitest';
import { createToolCall, isSameToolCall } from '../../../src/domain/agent-action';
import { InvalidToolCallError } from '../../../src/domain/errors';

const TASK = 'List every table without a caption';

describe('createToolCall', () => {
  it('accepts a delegated task with optional file hints', () => {
    expect(createToolCall({ tool: 'delegate', task: `  ${TASK} ` })).toEqual({
      tool: 'delegate',
      task: TASK,
      files: [],
    });
    expect(createToolCall({ tool: 'delegate', task: TASK, files: ['a.tex', 'ch/b.tex'] })).toEqual({
      tool: 'delegate',
      task: TASK,
      files: ['a.tex', 'ch/b.tex'],
    });
  });

  it('identifies a delegation by its task', () => {
    const first = createToolCall({ tool: 'delegate', task: TASK, files: ['a.tex'] });
    expect(isSameToolCall(first, createToolCall({ tool: 'delegate', task: TASK }))).toBe(true);
    expect(
      isSameToolCall(first, createToolCall({ tool: 'delegate', task: `${TASK} in chapter 2` })),
    ).toBe(false);
    expect(isSameToolCall(first, { tool: 'search', query: TASK })).toBe(false);
  });

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

  it('accepts a file or folder to search in', () => {
    expect(createToolCall({ tool: 'search', query: 'abc', path: 'chapters' })).toEqual({
      tool: 'search',
      query: 'abc',
      path: 'chapters',
    });
  });

  it('says how to search the whole project when a search path is invalid', () => {
    expect(() => createToolCall({ tool: 'search', query: 'abc', path: '.' })).toThrow(
      new InvalidToolCallError(
        'path "." must be relative to the project root, without empty, "." or ".." parts; leave the path out to search the whole project',
      ),
    );
  });

  it('tells searches in different places apart', () => {
    const everywhere = createToolCall({ tool: 'search', query: 'abc' });
    const inChapters = createToolCall({ tool: 'search', query: 'abc', path: 'chapters' });
    expect(isSameToolCall(everywhere, inChapters)).toBe(false);
    expect(isSameToolCall(inChapters, { tool: 'search', query: 'abc', path: 'chapters' })).toBe(
      true,
    );
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
    ['search in a broken path', { tool: 'search', query: 'abc', path: '../a.tex' }],
    ['search with lines', { tool: 'search', query: 'abc', path: 'a.tex', startLine: 1 }],
    ['compile with a path', { tool: 'compile', path: 'main.tex' }],
    ['delegate without a task', { tool: 'delegate' }],
    ['a too short task', { tool: 'delegate', task: ' short ' }],
    ['a too long task', { tool: 'delegate', task: 'x'.repeat(1_001) }],
    ['a multi-line task', { tool: 'delegate', task: 'Check the tables\nof chapter 2' }],
    ['delegate with a path', { tool: 'delegate', task: TASK, path: 'a.tex' }],
    ['delegate with a query', { tool: 'delegate', task: TASK, query: 'x' }],
    ['delegate with lines', { tool: 'delegate', task: TASK, startLine: 1 }],
    ['files that are no list', { tool: 'delegate', task: TASK, files: 'a.tex' }],
    ['a broken file path', { tool: 'delegate', task: TASK, files: ['a.tex', '../b.tex'] }],
    ['a file named twice', { tool: 'delegate', task: TASK, files: ['a.tex', 'a.tex'] }],
    [
      'too many files',
      {
        tool: 'delegate',
        task: TASK,
        files: Array.from({ length: 21 }, (_, i) => `f${String(i)}.tex`),
      },
    ],
    ['read_file with a task', { tool: 'read_file', path: 'a.tex', task: TASK }],
    ['search with files', { tool: 'search', query: 'abc', files: [] }],
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
