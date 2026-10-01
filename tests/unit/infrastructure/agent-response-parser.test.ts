import { describe, expect, it } from 'vitest';
import { AgentTool } from '../../../src/domain/agent-action';
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
      'the text you quoted starts line 2',
    ],
  ])('rejects %s', (_name, raw, expected) => {
    expect(problem(raw)).toContain(expected);
  });
});
