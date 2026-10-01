import { describe, expect, it } from 'vitest';
import { AgentTool } from '../../../src/domain/agent-action';
import type { AgentTurn } from '../../../src/domain/agent-transcript';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { ProjectFileKind } from '../../../src/domain/project-file';
import { createAgentExchange } from '../../../src/infrastructure/ollama/agent-protocol';
import {
  createCorrectionRequest,
  getPromptBudget,
  MIN_CONTEXT_TOKENS,
} from '../../../src/infrastructure/ollama/assistant-protocol';
import type { AgentStepRequest } from '../../../src/ports/agent-port';
import { AssistantRequestTooLargeError } from '../../../src/ports/errors';

const budget = getPromptBudget(MIN_CONTEXT_TOKENS);
const main = createDocumentSnapshot(['\\section{A}', 'Body.']);
const bib = createDocumentSnapshot(['@book{a,', '}']);

const turns: readonly AgentTurn[] = [
  {
    call: { tool: AgentTool.ReadFile, path: 'refs.bib' },
    result: { tool: AgentTool.ReadFile, path: 'refs.bib', document: bib },
  },
  {
    call: { tool: AgentTool.Search, query: 'fig:a' },
    result: {
      tool: AgentTool.Search,
      matches: [{ path: 'main.tex', lineNumber: 2, lineText: 'See \\ref{fig:a}.' }],
      truncated: true,
    },
  },
  {
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
  message: 'Add a citation',
  conversation: [],
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
    expect(sent.prompt).not.toContain('Selected text:');
    expect(sent.prompt).not.toContain('Result 1');
    expect(sent.prompt.endsWith('Lookups left: 6')).toBe(true);
  });

  it('shows the selection', () => {
    const selected = request({ workspace: { ...request().workspace, selection: 'Bo' } });
    expect(createAgentExchange(selected, budget).request.prompt).toContain('Selected text:\nBo');
  });

  it('shows every tool result in order, numbered like the lines the model may quote', () => {
    const { prompt } = createAgentExchange(request({ transcript: turns }), budget).request;
    expect(prompt).toContain('Result 1 (read_file refs.bib):\n1: @book{a,\n2: }');
    expect(prompt).toContain(
      'Result 2 (search "fig:a"):\nmain.tex:2: See \\ref{fig:a}.\n(more matches omitted',
    );
    expect(prompt).toContain(
      'Result 3 (compile):\nerror main.tex:2: Undefined control sequence.\nwarning main.tex: Overfull box.\ntypesetting Font shape undefined.',
    );
    expect(prompt.indexOf('Result 1')).toBeLessThan(prompt.indexOf('Result 3'));
    expect(prompt.endsWith('Lookups left: 3')).toBe(true);
  });

  it('says so when a search or compile found nothing', () => {
    const empty: readonly AgentTurn[] = [
      {
        call: { tool: AgentTool.Search, query: 'zz' },
        result: { tool: AgentTool.Search, matches: [], truncated: false },
      },
      {
        call: { tool: AgentTool.Compile },
        result: { tool: AgentTool.Compile, diagnostics: [] },
      },
    ];
    const { prompt } = createAgentExchange(request({ transcript: empty }), budget).request;
    expect(prompt).toContain('(search "zz"):\n(no matches)');
    expect(prompt).toContain('(compile):\n(no problems)');
  });

  it('tells the model to reply once the tools are used up', () => {
    const used = Array.from({ length: 6 }, (_, index) => ({
      call: { tool: AgentTool.Search, query: `q${String(index)}` },
      result: { tool: AgentTool.Search, matches: [], truncated: false },
    }));
    const { prompt } = createAgentExchange(request({ transcript: used }), budget).request;
    expect(prompt).toContain('Lookups left: 0. Reply now with ACTION: answer, question or edit.');
  });

  it('parses replies against the request it was built for', () => {
    const exchange = createAgentExchange(request({ transcript: turns }), budget);
    expect(exchange.parse('ACTION: read_file\nPATH: main.tex')).toEqual({
      kind: 'tool',
      call: { tool: 'read_file', path: 'main.tex' },
    });
    expect(() => exchange.parse('ACTION: compile')).toThrow('already called');
  });

  it('asks for one action in a correction', () => {
    const exchange = createAgentExchange(request(), budget);
    const correction = createCorrectionRequest(exchange, 'bad', 'unknown action');
    expect(correction.prompt).toContain('It was rejected because: unknown action.');
    expect(correction.prompt).toContain(
      'Reply again with exactly one action: the first line ACTION: read_file|search|compile|answer|question|edit',
    );
  });
});

describe('agent prompt budget', () => {
  const long = createDocumentSnapshot(Array.from({ length: 20_000 }, () => 'x'.repeat(40)));
  const longRead = (path: string): AgentTurn => ({
    call: { tool: AgentTool.ReadFile, path },
    result: { tool: AgentTool.ReadFile, path, document: long },
  });

  it('gives the open file the whole room when there are no tool results', () => {
    const exchange = createAgentExchange(
      request({
        workspace: { ...request().workspace, openFile: { path: 'main.tex', document: long } },
      }),
      budget,
    );
    expect(size(exchange)).toBeLessThanOrEqual(budget);
    expect(size(exchange)).toBeGreaterThan(budget - 100);
  });

  it('compacts the open file and older results before the newest result', () => {
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
    const [open, older, newer] = marks;
    expect(older).toBeGreaterThan(newer!);
    expect(open).toBeLessThan(older!);
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
    expect(() => createAgentExchange(request({ message: 'm'.repeat(budget) }), budget)).toThrow(
      AssistantRequestTooLargeError,
    );
  });
});
