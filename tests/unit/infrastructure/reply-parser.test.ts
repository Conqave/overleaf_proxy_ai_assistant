import { describe, expect, it } from 'vitest';
import type { EditRequest } from '../../../src/domain/change-set';
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
    [
      'ACTION: delegate\nTASK: List every table without \\caption, with path:line',
      { tool: 'delegate', task: 'List every table without \\caption, with path:line', files: [] },
    ],
    [
      'ACTION: delegate\nTASK: Check every \\cite key\nFILES: ch/a.tex,  ch/b.tex ',
      { tool: 'delegate', task: 'Check every \\cite key', files: ['ch/a.tex', 'ch/b.tex'] },
    ],
    [
      'ACTION: delegate\nTASK: Check every \\cite key\nFILES:',
      { tool: 'delegate', task: 'Check every \\cite key', files: [] },
    ],
  ])('parses %j', (raw, call) => {
    expect(parseAgentDecision(raw)).toEqual({ kind: 'tool', call });
  });

  it.each([
    ['a path outside the project', 'ACTION: read_file\nPATH: ../x.tex', 'must be relative'],
    ['a read without a path', 'ACTION: read_file', 'read_file requires a path'],
    [
      'a search with a path',
      'ACTION: search\nQUERY: ab\nPATH: main.tex',
      'ACTION: search takes only QUERY; remove PATH',
    ],
    ['a one-letter query', 'ACTION: search\nQUERY: a', 'must have 2 to 200 characters'],
    ['a compile with content', 'ACTION: compile\nCONTENT:\nx', 'has no content'],
    [
      'an unknown field',
      'ACTION: compile\nFILE: main.tex',
      'ACTION: compile takes no other lines; remove FILE',
    ],
    ['a stray line', 'ACTION: compile\nnow', 'unexpected line "now"; every line before CONTENT:'],
    ['a text start line', 'ACTION: read_file\nPATH: a.tex\nSTART_LINE: ten', 'must be a number'],
    [
      'a range ending before it starts',
      'ACTION: read_file\nPATH: a.tex\nSTART_LINE: 9\nEND_LINE: 2',
      'comes before the start line',
    ],
    ['a search with a start line', 'ACTION: search\nQUERY: ab\nSTART_LINE: 2', 'remove START_LINE'],
    ['a delegation without a task', 'ACTION: delegate\nFILES: a.tex', 'delegate requires a task'],
    [
      'a delegation with a path',
      'ACTION: delegate\nTASK: Check every key\nPATH: a.tex',
      'ACTION: delegate takes only TASK, FILES; remove PATH',
    ],
    [
      'a file list with an empty entry',
      'ACTION: delegate\nTASK: Check every key\nFILES: a.tex,,b.tex',
      'must be relative to the project root',
    ],
    ['a read with a task', 'ACTION: read_file\nPATH: a.tex\nTASK: x', 'remove TASK'],
  ])('rejects %s', (_name, raw, expected) => {
    expect(problem(raw)).toContain(expected);
  });

  it('names every unexpected field and line at once', () => {
    expect(
      problem(
        'ACTION: read_file\nPATH: a.tex\nQUERY: x\nLINE: 4\nLINE_TEXT: y\nQUERY: z\nplease\nthanks',
      ),
    ).toBe(
      'ACTION: read_file takes only PATH, START_LINE, END_LINE; remove QUERY, LINE, LINE_TEXT; unexpected lines "please", "thanks"; every line before CONTENT: must be one of PATH, START_LINE, END_LINE followed by ": "',
    );
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
        edits: [
          {
            path: 'refs.bib',
            command: {
              operation: 'replace',
              target: { lineNumber: 9, lineText: '\\title{A}' },
              lineCount: 1,
              content: '\\title{B}',
              reason: 'r',
            },
          },
        ],
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
      'ACTION: edit\nPATH: main.tex\nQUESTION: x?\nTEXT: y',
      'ACTION: edit takes only PATH, OPERATION, LINE, END_LINE, LINE_TEXT, REASON; remove QUESTION, TEXT',
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

  const parse = (raw: string): EditRequest => {
    const decision = parseAgentDecision(raw);
    if (decision.kind !== 'reply' || decision.reply.kind !== 'edit') {
      throw new TestFixtureError('the reply was no edit');
    }
    const [only, ...others] = decision.reply.edits;
    if (only === undefined || others.length)
      throw new TestFixtureError('the reply has no single edit');
    return only;
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
    expect(reply).toMatchObject({ path: 'main.tex' });
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

describe('parseAgentDecision edit blocks', () => {
  const block = (
    path: string,
    line: number,
    operation = 'replace',
    content = `Line ${String(line)}.`,
  ) =>
    [
      `PATH: ${path}`,
      `OPERATION: ${operation}`,
      `LINE: ${String(line)}`,
      `LINE_TEXT: old ${String(line)}`,
      ...(operation === 'delete' ? [] : ['CONTENT:', content]),
    ].join('\n');

  const editsOf = (raw: string) => {
    const decision = parseAgentDecision(raw);
    if (decision.kind !== 'reply' || decision.reply.kind !== 'edit') {
      throw new TestFixtureError('the reply was no edit');
    }
    return decision.reply.edits;
  };

  it('reads one edit per block, each starting with its PATH line', () => {
    const edits = editsOf(
      [
        'ACTION: edit',
        block('chapters/results.tex', 2, 'replace', '\\label{sec:new}'),
        block('main.tex', 9, 'delete'),
        block('main.tex', 20, 'insert_after', 'See Section~\\ref{sec:new}.\n\nMore.'),
      ].join('\n'),
    );
    expect(edits).toEqual([
      {
        path: 'chapters/results.tex',
        command: {
          operation: 'replace',
          target: { lineNumber: 2, lineText: 'old 2' },
          lineCount: 1,
          content: '\\label{sec:new}',
        },
      },
      {
        path: 'main.tex',
        command: {
          operation: 'delete',
          target: { lineNumber: 9, lineText: 'old 9' },
          lineCount: 1,
        },
      },
      {
        path: 'main.tex',
        command: {
          operation: 'insert_after',
          target: { lineNumber: 20, lineText: 'old 20' },
          content: 'See Section~\\ref{sec:new}.\n\nMore.',
        },
      },
    ]);
  });

  it('keeps the fields of a block in any order after its PATH line', () => {
    const edits = editsOf(
      'ACTION: edit\nOPERATION: delete\nPATH: a.tex\nLINE: 1\nLINE_TEXT: x\nPATH: b.tex\nLINE: 2\nLINE_TEXT: y\nOPERATION: delete',
    );
    expect(edits.map(({ path }) => path)).toEqual(['a.tex', 'b.tex']);
  });

  it('accepts eight blocks and asks for fewer when there are more', () => {
    const blocks = (count: number) =>
      ['ACTION: edit', ...Array.from({ length: count }, (_, i) => block('main.tex', i + 1))].join(
        '\n',
      );
    expect(editsOf(blocks(8))).toHaveLength(8);
    expect(problem(blocks(9))).toBe(
      'one edit reply carries at most 8 edit blocks, but this one has 9; send at most 8 blocks: merge changes of neighbouring lines into one replace with LINE and END_LINE, or leave the rest for a later request',
    );
  });

  it('names the block that is wrong', () => {
    expect(
      problem(
        ['ACTION: edit', block('main.tex', 1), 'PATH: refs.bib\nOPERATION: replace'].join('\n'),
      ),
    ).toBe('edit block 2 of 2: LINE is missing');
  });

  it('tells the model that a header line after the content needs its own block', () => {
    expect(problem(`ACTION: edit\n${block('main.tex', 1)}\nOPERATION: delete`)).toContain(
      'a further edit block starts with its own PATH line',
    );
  });
});
