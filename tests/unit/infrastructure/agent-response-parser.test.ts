import { describe, expect, it } from 'vitest';
import { AgentTool, type AgentReply } from '../../../src/domain/agent-action';
import type { AgentTurn } from '../../../src/domain/agent-transcript';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { ProjectFileKind } from '../../../src/domain/project-file';
import { parseAgentDecision } from '../../../src/infrastructure/ollama/agent-response-parser';
import { InvalidAssistantResponse } from '../../../src/infrastructure/ollama/assistant-response-parser';
import type { AgentStepRequest } from '../../../src/ports/agent-port';
import { TestFixtureError } from '../../support/test-errors';

const main = createDocumentSnapshot(['\\title{A}', '\\section{Results}', 'Body.']);
const bib = createDocumentSnapshot(['@book{a,', '  title = {A}', '}']);

const readBib: AgentTurn = {
  call: { tool: AgentTool.ReadFile, path: 'refs.bib' },
  result: { tool: AgentTool.ReadFile, path: 'refs.bib', document: bib },
};

const request = (transcript: readonly AgentTurn[] = []): AgentStepRequest => ({
  message: 'm',
  conversation: [],
  workspace: {
    files: [
      { id: '1', path: 'main.tex', kind: ProjectFileKind.Text },
      { id: '2', path: 'refs.bib', kind: ProjectFileKind.Text },
      { id: '3', path: 'frog.jpg', kind: ProjectFileKind.Binary },
    ],
    openFile: { path: 'main.tex', document: main },
    cursorLine: 1,
    selection: '',
  },
  transcript,
});

const searchTurn = (query: string): AgentTurn => ({
  call: { tool: AgentTool.Search, query },
  result: { tool: AgentTool.Search, matches: [], truncated: false },
});

const problem = (raw: string, transcript: readonly AgentTurn[] = []): string => {
  try {
    parseAgentDecision(raw, request(transcript));
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
  ])('parses %j', (raw, call) => {
    expect(parseAgentDecision(raw, request())).toEqual({ kind: 'tool', call });
  });

  it.each([
    [
      'a file missing from the project',
      'ACTION: read_file\nPATH: appendix.tex',
      'no file appendix.tex',
    ],
    ['a binary file', 'ACTION: read_file\nPATH: frog.jpg', 'frog.jpg is not a text file'],
    ['a read without a path', 'ACTION: read_file', 'read_file requires a path'],
    ['a search with a path', 'ACTION: search\nQUERY: ab\nPATH: main.tex', 'search takes no path'],
    ['a one-letter query', 'ACTION: search\nQUERY: a', 'must have 2 to 200 characters'],
    ['a compile with content', 'ACTION: compile\nCONTENT:\nx', 'has no content'],
    ['an unknown field', 'ACTION: compile\nFILE: main.tex', 'unexpected line "FILE: main.tex"'],
  ])('rejects %s', (_name, raw, expected) => {
    expect(problem(raw)).toContain(expected);
  });

  it('rejects a repeated call and a call once the tools are used up', () => {
    expect(problem('ACTION: read_file\nPATH: refs.bib', [readBib])).toContain(
      'already called with the same argument',
    );
    const used = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'].map(searchTurn);
    expect(problem('ACTION: compile', used)).toContain('reply to the user now');
  });
});

describe('parseAgentDecision replies', () => {
  it('parses a multi-line answer, with the text starting on the marker line or below it', () => {
    expect(
      parseAgentDecision('ACTION: answer\nTEXT:\nLine one.\n\nLine two.\n', request()),
    ).toEqual({ kind: 'reply', reply: { kind: 'answer', text: 'Line one.\n\nLine two.' } });
    expect(parseAgentDecision('ACTION: answer\nTEXT: Inline.', request())).toMatchObject({
      reply: { text: 'Inline.' },
    });
  });

  it('parses a question', () => {
    expect(parseAgentDecision('ACTION: question\nQUESTION: Which one?', request())).toEqual({
      kind: 'reply',
      reply: { kind: 'question', text: 'Which one?' },
    });
  });

  it('resolves an edit of the open file against the open document', () => {
    const decision = parseAgentDecision(
      'ACTION: edit\nPATH: main.tex\nOPERATION: replace\nLINE: 1\nLINE_TEXT: \\title{A}\nREASON: r\nPLAN: p\nCONTENT:\n\\title{B}',
      request(),
    );
    expect(decision).toMatchObject({
      kind: 'reply',
      reply: {
        kind: 'edit',
        rationale: 'p',
        change: { path: 'main.tex', edit: { document: main, command: { content: '\\title{B}' } } },
      },
    });
  });

  it('resolves an edit of another file against the text it was read as', () => {
    const decision = parseAgentDecision(
      'ACTION: edit\nPATH: refs.bib\nOPERATION: insert_after\nLINE: 3\nLINE_TEXT: }\nCONTENT:\n@book{b,\n}',
      request([readBib]),
    );
    expect(decision).toMatchObject({
      reply: { change: { path: 'refs.bib', edit: { document: bib } } },
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
      'an edit of an unread file',
      'ACTION: edit\nPATH: refs.bib\nOPERATION: delete\nLINE: 1\nLINE_TEXT: @book{a,',
      'refs.bib must be read with read_file',
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
    [
      'an edit of a line that does not match',
      'ACTION: edit\nPATH: main.tex\nOPERATION: delete\nLINE: 3\nLINE_TEXT: \\section{Results}',
      'LINE_TEXT quotes line 2, not line 3',
    ],
  ])('rejects %s', (_name, raw, expected) => {
    expect(problem(raw)).toContain(expected);
  });
});

describe('parseAgentDecision edit header', () => {
  const shown = createDocumentSnapshot([
    '\\title{A}',
    '',
    '\\section{Results}',
    'Long paragraph. More.',
  ]);
  const shownRequest = (document = shown): AgentStepRequest => ({
    ...request(),
    workspace: { ...request().workspace, openFile: { path: 'main.tex', document } },
  });
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
      PLAN: 'After the results heading.',
      ...overrides,
    };
    const head = Object.entries(fields)
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([name, value]) => `${name}: ${value}`);
    return [...head, ...(content === '' ? [] : ['CONTENT:', content])].join('\n');
  };

  const parse = (raw: string, document = shown): AgentReply => {
    const decision = parseAgentDecision(raw, shownRequest(document));
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

  it('returns a validated edit resolved against the shown document', () => {
    const content = '\\begin{tabular}{l|r}\nA & 1 \\\\\\hline\n\\end{tabular}';
    expect(parse(edit({}, content))).toMatchObject({
      kind: 'edit',
      rationale: 'After the results heading.',
      change: {
        path: 'main.tex',
        edit: {
          document: shown,
          command: {
            operation: 'insert_after',
            target: { lineNumber: 3, lineText: '\\section{Results}' },
            content,
            reason: 'Adds a table.',
          },
        },
      },
    });
  });

  it('keeps leading blank lines of the content and drops trailing ones', () => {
    expect(parse(edit({}, '\n\\section{X}\n\n'))).toMatchObject({
      change: { edit: { command: { content: '\n\\section{X}' } } },
    });
  });

  it('accepts Windows line endings', () => {
    expect(parse(edit({}, 'X').replace(/\n/g, '\r\n'))).toMatchObject({
      change: { edit: { command: { operation: 'insert_after', content: 'X' } } },
    });
  });

  it('accepts a delete of one line without content or END_LINE', () => {
    expect(parse(edit({ OPERATION: 'delete' }, ''))).toMatchObject({
      change: { edit: { command: { operation: 'delete', lineCount: 1 } } },
    });
  });

  it('reads END_LINE as the last line of a replaced or deleted range', () => {
    expect(parse(edit({ OPERATION: 'replace', END_LINE: '4' }, 'New.'))).toMatchObject({
      change: {
        edit: { command: { operation: 'replace', target: { lineNumber: 3 }, lineCount: 2 } },
      },
    });
    expect(parse(edit({ OPERATION: 'delete', END_LINE: '4' }, ''))).toMatchObject({
      change: { edit: { command: { operation: 'delete', lineCount: 2 } } },
    });
  });

  it('tells the model when END_LINE is before LINE or given for an insertion', () => {
    expect(editProblem(edit({ OPERATION: 'delete', END_LINE: '2' }, ''))).toContain(
      'the delete range must end at or after its first line 3',
    );
    expect(editProblem(edit({ END_LINE: '4' }))).toContain('takes no range end');
  });

  it('sends a range past the end of the shown document back to the model', () => {
    expect(editProblem(edit({ OPERATION: 'delete', END_LINE: '9' }, ''))).toContain(
      'END_LINE must be a line of the document',
    );
  });

  it('reads an empty CONTENT block as no content', () => {
    expect(parse(`${edit({ OPERATION: 'delete' }, '')}\nCONTENT:\n`)).toMatchObject({
      change: { edit: { command: { operation: 'delete' } } },
    });
    expect(editProblem(`${edit({}, '')}\nCONTENT:`)).toContain('requires non-empty content');
  });

  it('accepts an edit without the optional REASON and PLAN', () => {
    const reply = parse(edit({ REASON: null, PLAN: null }));
    expect(reply).toMatchObject({ kind: 'edit' });
    expect(reply).not.toHaveProperty('rationale');
    expect(reply).not.toHaveProperty('change.edit.command.reason');
    expect(parse(edit({ REASON: '', PLAN: '' }))).not.toHaveProperty('rationale');
  });

  it('completes a long line from its quoted start', () => {
    const long = createDocumentSnapshot([
      'Track changes are available on all plans. They record every edit.',
    ]);
    const reply = parse(
      'ACTION: edit\nPATH: main.tex\nOPERATION: delete\nLINE: 1\nLINE_TEXT: Track changes are available on all plans.',
      long,
    );
    expect(reply).toMatchObject({
      change: { edit: { command: { target: { lineText: long.lines[0] } } } },
    });
  });

  it('tells the model which line starts with the text it quoted', () => {
    expect(editProblem(edit({ LINE: '2', LINE_TEXT: '\\section{Results}' }))).toContain(
      'LINE_TEXT quotes line 3, not line 2, which is an empty line; to target line 3 write LINE: 3',
    );
  });

  it('shows the lines around the targeted line when the quote belongs to another line', () => {
    expect(editProblem(edit({ LINE: '2', LINE_TEXT: '\\section{Results}' }))).toContain(
      'The lines around line 2 are:\n1: \\title{A}\n2: \n3: \\section{Results}\n4: Long paragraph. More.',
    );
  });

  it('rejects a header line written after the content', () => {
    expect(editProblem(edit({ PLAN: null }, '\\begin{table}\nPLAN: After the heading.'))).toContain(
      '"PLAN: After the heading." comes after CONTENT:',
    );
  });

  it('names the real line when LINE_TEXT does not match what the model was shown', () => {
    expect(editProblem(edit({ LINE: '4', LINE_TEXT: 'Long paragraph.' }))).toContain(
      'which reads: Long paragraph. More.',
    );
    expect(editProblem(edit({ LINE: '9', LINE_TEXT: 'x' }))).toContain('the document has 4 lines');
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
