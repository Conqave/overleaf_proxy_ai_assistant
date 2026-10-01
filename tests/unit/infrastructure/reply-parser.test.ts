import { describe, expect, it } from 'vitest';
import type { AgentReply } from '../../../src/domain/agent-action';
import {
  InvalidAssistantResponse,
  parseAgentDecision,
} from '../../../src/infrastructure/ollama/reply-parser';
import { TestFixtureError } from '../../support/test-errors';

const problem = (raw: string): string => {
  try {
    parseAgentDecision(raw);
  } catch (error) {
    if (error instanceof InvalidAssistantResponse) return error.problem;
    throw error;
  }
  throw new TestFixtureError('the reply was accepted');
};

describe('parseAgentDecision tool calls', () => {
  it.each([
    ['ACTION: read_file\nPATH: refs.bib', { tool: 'read_file', path: 'refs.bib' }],
    ['ACTION: search\nQUERY:  \\label{fig:a} ', { tool: 'search', query: '\\label{fig:a}' }],
    ['\n ACTION: compile\n', { tool: 'compile' }],
    [
      'ACTION: read_file\nPATH: refs.bib\nSTART_LINE: 40\nEND_LINE: 80',
      { tool: 'read_file', path: 'refs.bib', range: { startLine: 40, endLine: 80 } },
    ],
    [
      'ACTION: read_file\nPATH: refs.bib\nEND_LINE: 80',
      { tool: 'read_file', path: 'refs.bib', range: { startLine: 1, endLine: 80 } },
    ],
  ])('parses %j', (raw, call) => {
    expect(parseAgentDecision(raw)).toEqual({ kind: 'tool', call });
  });

  it.each([
    ['a path outside the project', 'ACTION: read_file\nPATH: ../x.tex', 'must be relative'],
    ['a read without a path', 'ACTION: read_file', 'read_file requires a path'],
    ['a search with a path', 'ACTION: search\nQUERY: ab\nPATH: main.tex', 'search takes no path'],
    ['a one-letter query', 'ACTION: search\nQUERY: a', 'must have 2 to 200 characters'],
    ['a compile with content', 'ACTION: compile\nCONTENT:\nx', 'has no content'],
    ['an unknown field', 'ACTION: compile\nFILE: main.tex', 'unexpected line "FILE: main.tex"'],
    ['a text start line', 'ACTION: read_file\nPATH: a.tex\nSTART_LINE: ten', 'must be a number'],
    [
      'a range ending before it starts',
      'ACTION: read_file\nPATH: a.tex\nSTART_LINE: 9\nEND_LINE: 2',
      'comes before the start line',
    ],
    [
      'a search with a start line',
      'ACTION: search\nQUERY: ab\nSTART_LINE: 2',
      'takes no start line',
    ],
  ])('rejects %s', (_name, raw, expected) => {
    expect(problem(raw)).toContain(expected);
  });
});

describe('parseAgentDecision replies', () => {
  it('parses a multi-line answer, with the text starting on the marker line or below it', () => {
    expect(parseAgentDecision('ACTION: answer\nTEXT:\nLine one.\n\nLine two.\n')).toEqual({
      kind: 'reply',
      reply: { kind: 'answer', text: 'Line one.\n\nLine two.' },
    });
    expect(parseAgentDecision('ACTION: answer\nTEXT: Inline.')).toMatchObject({
      reply: { text: 'Inline.' },
    });
  });

  it('parses a question', () => {
    expect(parseAgentDecision('ACTION: question\nQUESTION: Which one?')).toEqual({
      kind: 'reply',
      reply: { kind: 'question', text: 'Which one?' },
    });
  });

  it('parses an edit into the path and the command it names, without resolving it', () => {
    const decision = parseAgentDecision(
      'ACTION: edit\nPATH: refs.bib\nOPERATION: replace\nLINE: 9\nLINE_TEXT: \\title{A}\nREASON: r\nCONTENT:\n\\title{B}',
    );
    expect(decision).toEqual({
      kind: 'reply',
      reply: {
        kind: 'edit',
        path: 'refs.bib',
        command: {
          operation: 'replace',
          target: { lineNumber: 9, lineText: '\\title{A}' },
          lineCount: 1,
          content: '\\title{B}',
          reason: 'r',
        },
      },
    });
  });

  it.each([
    ['an empty reply', ' \n ', 'the reply text is empty'],
    ['JSON', '{"action":"answer"}', 'the reply is JSON'],
    ['prose before the action', 'Sure.\nACTION: answer\nTEXT: x', 'the first line must be ACTION'],
    ['an unknown action', 'ACTION: reply\nTEXT: x', 'unknown action "reply"'],
    ['an answer without TEXT', 'ACTION: answer\nThe answer.', 'continue with a TEXT: line'],
    ['an empty answer', 'ACTION: answer\nTEXT:\n  ', 'the text after TEXT: is empty'],
    ['an empty question', 'ACTION: question\nQUESTION: ', 'QUESTION is empty'],
    [
      'an edit of an absolute path',
      'ACTION: edit\nPATH: /main.tex\nOPERATION: delete\nLINE: 1\nLINE_TEXT: x',
      'must be relative to the project root',
    ],
    [
      'an edit without a path',
      'ACTION: edit\nOPERATION: delete\nLINE: 1\nLINE_TEXT: \\title{A}',
      'PATH is missing',
    ],
    [
      'an edit with a question',
      'ACTION: edit\nPATH: main.tex\nQUESTION: x?',
      'unexpected line "QUESTION: x?"',
    ],
  ])('rejects %s', (_name, raw, expected) => {
    expect(problem(raw)).toContain(expected);
  });
});

describe('parseAgentDecision edit header', () => {
  const edit = (
    overrides: Record<string, string | null> = {},
    content = '\\begin{table}\n\\end{table}',
  ) => {
    const fields: Record<string, string | null> = {
      ACTION: 'edit',
      PATH: 'main.tex',
      OPERATION: 'insert_after',
      LINE: '3',
      LINE_TEXT: '\\section{Results}',
      REASON: 'Adds a table.',
      ...overrides,
    };
    const head = Object.entries(fields)
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([name, value]) => `${name}: ${value}`);
    return [...head, ...(content === '' ? [] : ['CONTENT:', content])].join('\n');
  };

  const parse = (raw: string): AgentReply => {
    const decision = parseAgentDecision(raw);
    if (decision.kind !== 'reply') throw new TestFixtureError('the reply was a tool call');
    return decision.reply;
  };
  const editProblem = (raw: string): string => {
    try {
      parse(raw);
    } catch (error) {
      if (error instanceof InvalidAssistantResponse) return error.problem;
      throw error;
    }
    throw new TestFixtureError('the reply was accepted');
  };

  it('returns the validated command with its raw LaTeX content', () => {
    const content = '\\begin{tabular}{l|r}\nA & 1 \\\\\\hline\n\\end{tabular}';
    expect(parse(edit({}, content))).toMatchObject({
      kind: 'edit',
      path: 'main.tex',
      command: {
        operation: 'insert_after',
        target: { lineNumber: 3, lineText: '\\section{Results}' },
        content,
        reason: 'Adds a table.',
      },
    });
  });

  it('keeps leading blank lines of the content and drops trailing ones', () => {
    expect(parse(edit({}, '\n\\section{X}\n\n'))).toMatchObject({
      command: { content: '\n\\section{X}' },
    });
  });

  it('accepts Windows line endings', () => {
    expect(parse(edit({}, 'X').replace(/\n/g, '\r\n'))).toMatchObject({
      command: { operation: 'insert_after', content: 'X' },
    });
  });

  it('accepts a delete of one line without content or END_LINE', () => {
    expect(parse(edit({ OPERATION: 'delete' }, ''))).toMatchObject({
      command: { operation: 'delete', lineCount: 1 },
    });
  });

  it('reads END_LINE as the last line of a replaced or deleted range', () => {
    expect(parse(edit({ OPERATION: 'replace', END_LINE: '4' }, 'New.'))).toMatchObject({
      command: { operation: 'replace', target: { lineNumber: 3 }, lineCount: 2 },
    });
    expect(parse(edit({ OPERATION: 'delete', END_LINE: '4' }, ''))).toMatchObject({
      command: { operation: 'delete', lineCount: 2 },
    });
  });

  it('tells the model when END_LINE is before LINE or given for an insertion', () => {
    expect(editProblem(edit({ OPERATION: 'delete', END_LINE: '2' }, ''))).toContain(
      'the delete range must end at or after its first line 3',
    );
    expect(editProblem(edit({ END_LINE: '4' }))).toContain('takes no range end');
  });

  it('reads an empty CONTENT block as no content', () => {
    expect(parse(`${edit({ OPERATION: 'delete' }, '')}\nCONTENT:\n`)).toMatchObject({
      command: { operation: 'delete' },
    });
    expect(editProblem(`${edit({}, '')}\nCONTENT:`)).toContain('requires non-empty content');
  });

  it('accepts an edit without the optional REASON', () => {
    const reply = parse(edit({ REASON: null }));
    expect(reply).toMatchObject({ kind: 'edit' });
    expect(reply).not.toHaveProperty('command.reason');
    expect(parse(edit({ REASON: '' }))).not.toHaveProperty('command.reason');
  });

  it('tells the model to put content below the CONTENT: line, not on it', () => {
    expect(editProblem(edit().replace('CONTENT:\n', 'CONTENT: '))).toContain(
      'puts text on the CONTENT: line; write CONTENT: alone on its line and the new LaTeX on the lines below it',
    );
  });

  it('rejects a header line written after the content', () => {
    expect(editProblem(edit({ REASON: null }, '\\begin{table}\nREASON: Adds a table.'))).toContain(
      '"REASON: Adds a table." comes after CONTENT:',
    );
  });

  it.each([
    ['unknown field', edit({ ANCHOR: 'x' })],
    ['field glued to its value', edit().replace('LINE: 3', 'LINE:3')],
    ['field twice', edit().replace('CONTENT:', 'LINE: 3\nCONTENT:')],
    ['unknown operation', edit({ OPERATION: 'explain' })],
    ['missing line', edit({ LINE: null })],
    ['line as text', edit({ LINE: 'three' })],
    ['missing line text', edit({ LINE_TEXT: null })],
    ['END_LINE as text', edit({ OPERATION: 'delete', END_LINE: 'four' }, '')],
    ['missing content', edit({}, '')],
    ['content on delete', edit({ OPERATION: 'delete' })],
    ['fenced content', edit({}, '```latex\n\\section{X}\n```')],
  ])('rejects %s', (_name, raw) => {
    expect(() => parse(raw)).toThrow(InvalidAssistantResponse);
  });
});
