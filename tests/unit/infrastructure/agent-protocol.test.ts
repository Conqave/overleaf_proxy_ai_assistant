import { EMPTY_CONVERSATION } from '../../support/fakes';
import { describe, expect, it } from 'vitest';
import { AgentTool } from '../../../src/domain/agent-action';
import type { AgentTurn } from '../../../src/domain/agent-transcript';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { ProjectFileKind } from '../../../src/domain/project-file';
import { createAgentExchange } from '../../../src/infrastructure/ollama/agent-protocol';
import {
  CURRENT_RESULT_SHARE,
  ESTIMATED_PROMPT_CHARS,
  SEARCH_OUTPUT_CHARS,
} from '../../../src/infrastructure/ollama/context-budget';
import { getReadSpan } from '../../../src/domain/read-window';
import {
  createCorrectionRequest,
  getCorrectionReserveChars,
} from '../../../src/infrastructure/ollama/correction-exchange';
import type { AgentStepRequest } from '../../../src/ports/agent-port';
import { AssistantRequestTooLargeError } from '../../../src/ports/errors';
import { itemAt } from '../../support/guards';

const budget = 20_480;
const main = createDocumentSnapshot(['\\section{A}', 'Body.']);
const bib = createDocumentSnapshot(['@book{a,', '}']);

const turns: readonly AgentTurn[] = [
  {
    kind: 'tool',
    call: { tool: AgentTool.ReadFile, path: 'refs.bib' },
    result: {
      tool: AgentTool.ReadFile,
      path: 'refs.bib',
      document: bib,
      shown: { first: 1, last: 2 },
    },
  },
  {
    kind: 'tool',
    call: { tool: AgentTool.Search, query: 'fig:a' },
    result: {
      tool: AgentTool.Search,
      matches: [{ path: 'main.tex', lineNumber: 2, lineText: 'See \\ref{fig:a}.' }],
      truncated: true,
    },
  },
  {
    kind: 'tool',
    call: { tool: AgentTool.Compile },
    result: {
      tool: AgentTool.Compile,
      diagnostics: [
        { level: 'error', message: 'Undefined control sequence.', path: 'main.tex', lineNumber: 2 },
        { level: 'warning', message: 'Overfull box.', path: 'main.tex' },
        { level: 'typesetting', message: 'Font shape undefined.' },
      ],
    },
  },
];

const request = (overrides: Partial<AgentStepRequest> = {}): AgentStepRequest => ({
  request: { kind: 'user', message: { id: 'r', role: 'user', text: 'Add a citation' } },
  conversation: EMPTY_CONVERSATION,
  signal: new AbortController().signal,
  workspace: {
    files: [
      { id: '1', path: 'main.tex', kind: ProjectFileKind.Text },
      { id: '2', path: 'refs.bib', kind: ProjectFileKind.Text },
      { id: '3', path: 'frog.jpg', kind: ProjectFileKind.Binary },
    ],
    openFile: { path: 'main.tex', document: main },
    cursorLine: 2,
    selection: '',
  },
  transcript: [],
  ...overrides,
});

const size = (exchange: ReturnType<typeof createAgentExchange>): number =>
  exchange.request.system.length + exchange.request.prompt.length;

describe('agent exchange', () => {
  it('documents the actions and shows the workspace', () => {
    const { request: sent } = createAgentExchange(request(), budget);
    expect(sent.system).toContain('ACTION: read_file\nPATH: sample.bib');
    expect(sent.system).toContain('OPERATION: insert_before|insert_after|replace|delete');
    expect(sent.prompt).toContain('User message:\nAdd a citation');
    expect(sent.prompt).toContain(
      'Project files:\nmain.tex (open in the editor)\nrefs.bib\nfrog.jpg (binary)',
    );
    expect(sent.prompt).toContain(
      'Numbered lines of main.tex (open in the editor, caret on line 2):\n1: \\section{A}\n2: Body.',
    );
    expect(sent.prompt).not.toContain('Selected text');
    expect(sent.prompt).not.toContain('Result 1');
    expect(sent.prompt.endsWith('Lookups left: 6')).toBe(true);
  });

  it('allows Markdown in answers but not in the content of an edit', () => {
    const { system } = createAgentExchange(request(), budget).request;
    expect(system).toMatch(/- answer: [^\n]*may use Markdown/);
    expect(system).toMatch(/- Everything after CONTENT: [^\n]*no Markdown\./);
  });

  it('shows the selection', () => {
    const selected = request({ workspace: { ...request().workspace, selection: 'Bo' } });
    expect(createAgentExchange(selected, budget).request.prompt).toContain(
      'Selected text (in the open file; a request to change, fix or translate it asks for an edit of that file):\nBo',
    );
  });

  it('asks for a translation of file text as an edit, not as an answer', () => {
    const { system } = createAgentExchange(request(), budget).request;
    expect(system).toContain(
      'a translation of file text is an edit that replaces that text in its file',
    );
    expect(system).toContain(
      'applied to text of a file, including the selected text, ask for an edit of that file even when the user does not name the file; the new text never goes into an answer.',
    );
  });

  it('asks to compile first instead of guessing the errors from the source', () => {
    const { system } = createAgentExchange(request(), budget).request;
    expect(system).toContain(
      'your first action is compile, before any read_file: you cannot compile in your head, and only its result shows the real errors and where they are;',
    );
  });

  it('shows every tool result in order, numbered like the lines the model may quote', () => {
    const { prompt } = createAgentExchange(request({ transcript: turns }), budget).request;
    expect(prompt).toContain('Result 1 (read_file refs.bib):\n1: @book{a,\n2: }');
    expect(prompt).toContain(
      'Result 2 (search "fig:a"):\nmain.tex:2: See \\ref{fig:a}.\n(more matches or text omitted',
    );
    expect(prompt).toContain(
      'Result 3 (compile):\nerror main.tex:2: Undefined control sequence.\nwarning main.tex: Overfull box.\ntypesetting Font shape undefined.',
    );
    expect(prompt.indexOf('Result 1')).toBeLessThan(prompt.indexOf('Result 3'));
    expect(prompt.endsWith('Lookups left: 3')).toBe(true);
  });

  it('shows a part of a long file with the lines it covers and how to read on', () => {
    const chapter = createDocumentSnapshot(
      Array.from({ length: 30 }, (_, index) => `Line ${String(index + 1)}.`),
    );
    const part: AgentTurn = {
      kind: 'tool',
      call: { tool: AgentTool.ReadFile, path: 'ch.tex', range: { startLine: 10, endLine: 11 } },
      result: {
        tool: AgentTool.ReadFile,
        path: 'ch.tex',
        document: chapter,
        shown: { first: 10, last: 11 },
      },
    };
    const { prompt, system } = createAgentExchange(request({ transcript: [part] }), budget).request;
    expect(prompt).toContain(
      'Result 1 (read_file ch.tex from line 10 to 11):\n[Showing only lines 10–11 of 30; the file has 30 lines and the others exist but are not shown here. Read another range with START_LINE and END_LINE, or search.]\n10: Line 10.\n11: Line 11.',
    );
    expect(system).toContain('add START_LINE and END_LINE (line numbers, both optional)');
    expect(system).toContain('A result "Showing only lines A–B of N" shows only part of the file');
  });

  it('shows an empty file as empty', () => {
    const empty: AgentTurn = {
      kind: 'tool',
      call: { tool: AgentTool.ReadFile, path: 'e.tex' },
      result: {
        tool: AgentTool.ReadFile,
        path: 'e.tex',
        document: createDocumentSnapshot([]),
        shown: { first: 1, last: 0 },
      },
    };
    const { prompt } = createAgentExchange(request({ transcript: [empty] }), budget).request;
    expect(prompt).toContain('Result 1 (read_file e.tex):\n(empty file)');
  });

  it('shortens a long search output and asks for a more specific query at its end', () => {
    const long: AgentTurn = {
      kind: 'tool',
      call: { tool: AgentTool.Search, query: 'the' },
      result: {
        tool: AgentTool.Search,
        matches: Array.from({ length: 20 }, (_, index) => ({
          path: 'main.tex',
          lineNumber: index + 1,
          lineText: 'the '.repeat(250),
        })),
        truncated: false,
      },
    };
    const { prompt } = createAgentExchange(
      request({ transcript: [long] }),
      ESTIMATED_PROMPT_CHARS,
    ).request;
    const shown = prompt.slice(prompt.indexOf('Result 1'), prompt.indexOf('Lookups left'));
    expect(shown.length).toBeLessThan(SEARCH_OUTPUT_CHARS + 200);
    expect(shown).toContain('[AUTOCOMPACTED: omitted');
    expect(
      shown
        .trimEnd()
        .endsWith('(more matches or text omitted; search for something more specific)'),
    ).toBe(true);
  });

  it('says so when a search or compile found nothing', () => {
    const empty: readonly AgentTurn[] = [
      {
        kind: 'tool',
        call: { tool: AgentTool.Search, query: 'zz' },
        result: { tool: AgentTool.Search, matches: [], truncated: false },
      },
      {
        kind: 'tool',
        call: { tool: AgentTool.Compile },
        result: { tool: AgentTool.Compile, diagnostics: [] },
      },
    ];
    const { prompt } = createAgentExchange(request({ transcript: empty }), budget).request;
    expect(prompt).toContain('(search "zz"):\n(no matches)');
    expect(prompt).toContain('(compile):\n(no problems)');
  });

  it('tells the model to reply once the tools are used up', () => {
    const used = Array.from({ length: 6 }, (_, index): AgentTurn => ({
      kind: 'tool',
      call: { tool: AgentTool.Search, query: `q${String(index)}` },
      result: { tool: AgentTool.Search, matches: [], truncated: false },
    }));
    const { prompt } = createAgentExchange(request({ transcript: used }), budget).request;
    expect(prompt).toContain('Lookups left: 0. Reply now with ACTION: answer, question or edit.');
  });

  it('parses the syntax of a reply and leaves its policy to the caller', () => {
    const exchange = createAgentExchange(request({ transcript: turns }), budget);
    expect(exchange.parse('ACTION: compile')).toEqual({
      kind: 'tool',
      call: { tool: 'compile' },
    });
  });

  it('shows a rejected step with the problem the model has to correct', () => {
    const rejected: readonly AgentTurn[] = [
      {
        kind: 'mistake',
        decision: { kind: 'tool', call: { tool: AgentTool.ReadFile, path: 'gone.tex' } },
        problem: 'The project has no file gone.tex.',
      },
      {
        kind: 'mistake',
        decision: {
          kind: 'reply',
          reply: {
            kind: 'edit',
            path: 'main.tex',
            command: createDocumentCommand({
              operation: 'delete',
              target: { lineNumber: 9, lineText: 'x' },
            }),
          },
        },
        problem: 'Line 9 does not exist; the document has 2 lines.',
      },
    ];
    const { prompt, system } = createAgentExchange(
      request({ transcript: rejected }),
      budget,
    ).request;
    expect(prompt).toContain(
      'Result 1 (read_file gone.tex, rejected):\nThe project has no file gone.tex.',
    );
    expect(prompt).toContain(
      'Result 2 (edit main.tex, rejected):\nLine 9 does not exist; the document has 2 lines.',
    );
    expect(prompt.endsWith('Lookups left: 6')).toBe(true);
    expect(system).toContain('A result marked rejected explains why');
  });

  it('asks for one action in a correction', () => {
    const exchange = createAgentExchange(request(), budget);
    const correction = createCorrectionRequest(exchange, 'bad', 'unknown action');
    expect(correction.system).toBe(exchange.request.system);
    expect(correction.prompt.startsWith(exchange.request.prompt)).toBe(true);
    expect(correction.prompt).toContain('Your previous reply was:\nbad');
    expect(correction.prompt).toContain('It was rejected because: unknown action.');
    expect(correction.prompt).toContain(
      'Reply again with exactly one action: the first line ACTION: read_file|search|compile|answer|question|edit',
    );
    const long = createCorrectionRequest(exchange, 'z'.repeat(100_000), 'x'.repeat(100_000));
    expect(long.prompt.length - exchange.request.prompt.length).toBeLessThanOrEqual(
      getCorrectionReserveChars(exchange.retryInstruction),
    );
  });
});

describe('agent prompt budget', () => {
  const long = createDocumentSnapshot(Array.from({ length: 20_000 }, () => 'x'.repeat(40)));
  const longRead = (path: string): AgentTurn => ({
    kind: 'tool',
    call: { tool: AgentTool.ReadFile, path },
    result: {
      tool: AgentTool.ReadFile,
      path,
      document: long,
      shown: { first: 1, last: long.lines.length },
    },
  });

  it('shows a whole read window uncut within the planned prompt', () => {
    const chapter = createDocumentSnapshot(
      Array.from(
        { length: 5_000 },
        (_, index) => `Sentence ${String(index + 1)} of a long chapter.`,
      ),
    );
    const shown = getReadSpan(chapter, undefined);
    const read: AgentTurn = {
      kind: 'tool',
      call: { tool: AgentTool.ReadFile, path: 'ch.tex' },
      result: { tool: AgentTool.ReadFile, path: 'ch.tex', document: chapter, shown },
    };
    const { prompt } = createAgentExchange(
      request({ transcript: [read] }),
      ESTIMATED_PROMPT_CHARS,
    ).request;
    expect(prompt).toContain(
      `${String(shown.last)}: Sentence ${String(shown.last)} of a long chapter.`,
    );
    expect(prompt).not.toContain('[shortened to');
    expect(prompt).not.toContain('AUTOCOMPACTED');
  });

  it('shortens a lookup result to a tenth of the prompt and says how to see the rest', () => {
    const noisy: AgentTurn = {
      kind: 'tool',
      call: { tool: AgentTool.Compile },
      result: {
        tool: AgentTool.Compile,
        diagnostics: Array.from({ length: 2_000 }, (_, index) => ({
          level: 'warning' as const,
          message: `Overfull hbox ${String(index)}.`,
        })),
      },
    };
    const { prompt } = createAgentExchange(
      request({ transcript: [noisy] }),
      ESTIMATED_PROMPT_CHARS,
    ).request;
    const result = prompt.slice(prompt.indexOf('Result 1'), prompt.indexOf('Lookups left'));
    expect(result.length).toBeLessThan(ESTIMATED_PROMPT_CHARS / CURRENT_RESULT_SHARE + 400);
    expect(result).toContain('Overfull hbox 1999.');
    expect(result).toContain(
      'characters; look up a smaller part (START_LINE and END_LINE, or a narrower search) to see the rest]',
    );
  });

  it('gives the open file the whole room when there are no tool results', () => {
    const withLong = request({
      workspace: { ...request().workspace, openFile: { path: 'main.tex', document: long } },
    });
    const exchange = createAgentExchange(withLong, budget);
    const roomier = createAgentExchange(withLong, budget + 1_000);
    expect(size(exchange)).toBeLessThanOrEqual(budget);
    expect(size(roomier) - size(exchange)).toBe(1_000);
  });

  it('shortens every result to a tenth of the prompt and fits the open file around them', () => {
    const exchange = createAgentExchange(
      request({
        workspace: { ...request().workspace, openFile: { path: 'main.tex', document: long } },
        transcript: [longRead('a.tex'), longRead('b.tex'), ...turns.slice(1)],
      }),
      budget,
    );
    const { prompt } = exchange.request;
    expect(size(exchange)).toBeLessThanOrEqual(budget);
    const marks = [...prompt.matchAll(/AUTOCOMPACTED: omitted (\d+) chars/g)].map((m) =>
      Number(m[1]),
    );
    expect(marks).toHaveLength(3);
    const open = itemAt(marks, 0, 'omission mark of the open file');
    const older = itemAt(marks, 1, 'omission mark of the older read');
    const newer = itemAt(marks, 2, 'omission mark of the newer read');
    expect(older).toBe(newer);
    expect(open).toBeLessThan(older);
    expect(prompt).toMatch(/\[shortened to \d+ characters; look up a smaller part/);
    expect(prompt).toContain('Result 4 (compile):\nerror main.tex:2');
  });

  it('keeps a small result whole while compacting a large one', () => {
    const exchange = createAgentExchange(
      request({ transcript: [longRead('a.tex'), turns[1]!] }),
      budget,
    );
    expect(exchange.request.prompt).toContain('main.tex:2: See \\ref{fig:a}.');
    expect(size(exchange)).toBeLessThanOrEqual(budget);
  });

  it('refuses rather than breaks at every tight budget', () => {
    const system = createAgentExchange(request(), budget).request.system.length;
    for (let tight = system; tight < system + 1_500; tight += 7) {
      const outcome = (() => {
        try {
          return size(createAgentExchange(request({ transcript: turns }), tight)) <= tight;
        } catch (error) {
          return error instanceof AssistantRequestTooLargeError;
        }
      })();
      expect(outcome).toBe(true);
    }
  });

  it('refuses a message too long for the context window', () => {
    expect(() =>
      createAgentExchange(
        request({
          request: { kind: 'user', message: { id: 'r', role: 'user', text: 'm'.repeat(budget) } },
        }),
        budget,
      ),
    ).toThrow(AssistantRequestTooLargeError);
  });
});
