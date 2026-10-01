import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { AgentTool, type AgentReply, type ToolCall } from '../../src/domain/agent-action';
import { AGENT_POLICY } from '../../src/domain/agent-policy';
import type { AgentTurn, CompileDiagnostic, ToolResult } from '../../src/domain/agent-transcript';
import { createDocumentSnapshot, type DocumentSnapshot } from '../../src/domain/document';
import { ProjectFileKind, type ProjectFile } from '../../src/domain/project-file';
import { searchProject } from '../../src/domain/project-search';
import { OllamaAgent } from '../../src/infrastructure/ollama/ollama-agent';
import { OllamaClient } from '../../src/infrastructure/ollama/ollama-client';
import type { AgentWorkspace, ContextUsage } from '../../src/ports/agent-port';
import { TestFixtureError } from '../support/test-errors';

const OLLAMA_URL = process.env.OLLAMA_CONTRACT_URL;
const CASE_TIMEOUT_MS = 600_000;
const REQUEST_TIMEOUT_MS = 300_000;

const MAIN = 'main.tex';
const BIB = 'sample.bib';
const RESULTS = 'chapters/results.tex';

const readFixture = (path: string): DocumentSnapshot =>
  createDocumentSnapshot(
    readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8')
      .replace(/\n$/, '')
      .split('\n'),
  );

function includeChapter(main: DocumentSnapshot): DocumentSnapshot {
  const at = main.lines.findIndex((line) => line.startsWith('\\section{Some examples'));
  if (at === -1) throw new TestFixtureError('the example document has no second section');
  return createDocumentSnapshot([
    ...main.lines.slice(0, at),
    '\\input{chapters/results}',
    '',
    ...main.lines.slice(at),
  ]);
}

const TEXTS: ReadonlyMap<string, DocumentSnapshot> = new Map([
  [MAIN, includeChapter(readFixture('overleaf-example.tex'))],
  [BIB, readFixture('project/sample.bib')],
  [RESULTS, readFixture(`project/${RESULTS}`)],
]);

const FILES: readonly ProjectFile[] = [
  { id: 'main', path: MAIN, kind: ProjectFileKind.Text },
  { id: 'bib', path: BIB, kind: ProjectFileKind.Text },
  { id: 'results', path: RESULTS, kind: ProjectFileKind.Text },
  { id: 'frog', path: 'frog.jpg', kind: ProjectFileKind.Binary },
];

function getText(texts: ReadonlyMap<string, DocumentSnapshot>, path: string): DocumentSnapshot {
  const document = texts.get(path);
  if (document === undefined) throw new TestFixtureError(`the fixture project has no ${path}`);
  return document;
}

function lineOf(path: string, needle: string): number {
  const index = getText(TEXTS, path).lines.findIndex((line) => line.includes(needle));
  if (index === -1) throw new TestFixtureError(`${path} has no line with ${needle}`);
  return index + 1;
}

function lineText(path: string, lineNumber: number): string {
  const text = getText(TEXTS, path).lines[lineNumber - 1];
  if (text === undefined) {
    throw new TestFixtureError(`${path} has no line ${String(lineNumber)}`);
  }
  return text;
}

const BROKEN_LINE = lineOf(RESULTS, '\\begin{tabular}');
const BROKEN_TEXTS: ReadonlyMap<string, DocumentSnapshot> = new Map([
  ...TEXTS,
  [
    RESULTS,
    createDocumentSnapshot(
      getText(TEXTS, RESULTS).lines.map((line, index) =>
        index + 1 === BROKEN_LINE ? line.replace('\\begin', '\\begn') : line,
      ),
    ),
  ],
]);
const BROKEN_DIAGNOSTICS: readonly CompileDiagnostic[] = [
  {
    level: 'error',
    message: 'Undefined control sequence.',
    path: RESULTS,
    lineNumber: BROKEN_LINE,
  },
  {
    level: 'error',
    message: 'LaTeX Error: \\begin{table} on input line 6 ended by \\end{tabular}.',
    path: RESULTS,
    lineNumber: BROKEN_LINE + 4,
  },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new TestFixtureError(`${name} must be set together with OLLAMA_CONTRACT_URL`);
  }
  return value;
}

type Operation = 'insert_before' | 'insert_after' | 'replace' | 'delete';

interface ExpectedEdit {
  readonly path: string;
  readonly operation: Operation;
  readonly line: number;
  readonly lastLines?: readonly number[];
  readonly content?: RegExp;
}

interface Case {
  readonly name: string;
  readonly request: string;
  readonly texts: ReadonlyMap<string, DocumentSnapshot>;
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly selection: string;
  readonly transcript: readonly AgentTurn[];
  readonly tools?: readonly (readonly ToolCall['tool'][])[];
  readonly answer?: RegExp;
  readonly edit?: ExpectedEdit;
}

const CLOSED_TRANSCRIPT: readonly AgentTurn[] = [
  {
    call: { tool: AgentTool.ReadFile, path: BIB },
    result: { tool: AgentTool.ReadFile, path: BIB, document: getText(TEXTS, BIB) },
  },
  ...['tabular', 'caption', 'section', 'label', 'figure'].map((query) => ({
    call: { tool: AgentTool.Search, query },
    result: { tool: AgentTool.Search, ...searchProject(textFiles(TEXTS), query) },
  })),
];

const UNTOUCHED_PROJECT = {
  texts: TEXTS,
  diagnostics: [],
  selection: '',
  transcript: [],
} as const satisfies Partial<Case>;

const CASES: readonly Case[] = [
  {
    ...UNTOUCHED_PROJECT,
    name: 'answers about the open file without tools',
    request: 'o czym jest ten dokument?',
    tools: [[]],
    answer: /szablon|przykład|LaTeX|Overleaf/i,
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'explains a formula of the open file without tools',
    request: 'wyjaśnij co oznacza wzór na S_n',
    tools: [[]],
    answer: /średni/i,
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'edits the open file without tools',
    request: 'zmień tytuł na Raport z laboratorium',
    tools: [[]],
    edit: {
      path: MAIN,
      operation: 'replace',
      line: lineOf(MAIN, '\\title{'),
      content: /^\\title\{Raport z laboratorium\}$/,
    },
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'rewrites a caption of the open file',
    request: 'popraw podpis rysunku z żabą, żeby brzmiał bardziej naukowo',
    tools: [[]],
    edit: {
      path: MAIN,
      operation: 'replace',
      line: lineOf(MAIN, '\\caption{\\label{fig:frog}'),
      content: /^\\caption\{\\label\{fig:frog\}[^\n]+\}$/,
    },
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'inserts a section before the bibliography',
    request: 'dodaj sekcję Conclusions z jednym zdaniem przed bibliografią',
    tools: [[]],
    edit: {
      path: MAIN,
      operation: 'insert_before',
      line: lineOf(MAIN, '\\bibliographystyle'),
      content: /\\section\{Conclusions\}/,
    },
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'deletes a whole subsection',
    request: 'usuń całą podsekcję o komentarzach i śledzeniu zmian razem z jej treścią',
    tools: [[]],
    edit: {
      path: MAIN,
      operation: 'delete',
      line: lineOf(MAIN, '\\subsection{How to add Comments and Track Changes}'),
      lastLines: [
        lineOf(MAIN, 'Track changes are available'),
        lineOf(MAIN, 'Track changes are available') + 1,
      ],
    },
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'inserts a table after an existing table',
    request: 'wstaw po tabeli z widgetami tabelę z trzema pomiarami temperatury',
    tools: [[]],
    edit: {
      path: MAIN,
      operation: 'insert_after',
      line: lineOf(MAIN, '\\end{table}'),
      content:
        /^\\begin\{table\}[\s\S]*\\begin\{tabular\}[\s\S]*\\end\{tabular\}[\s\S]*\\end\{table\}$/,
    },
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'deletes a paragraph',
    request: 'usuń akapit o track changes',
    tools: [[]],
    edit: {
      path: MAIN,
      operation: 'delete',
      line: lineOf(MAIN, 'Track changes are available'),
      lastLines: [
        lineOf(MAIN, 'Track changes are available'),
        lineOf(MAIN, 'Track changes are available') + 1,
      ],
    },
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'translates the selected paragraph',
    request: 'przetłumacz zaznaczony akapit na polski',
    selection: lineText(MAIN, lineOf(MAIN, 'Your introduction goes here')),
    tools: [[]],
    edit: {
      path: MAIN,
      operation: 'replace',
      line: lineOf(MAIN, 'Your introduction goes here'),
    },
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'reads the bibliography to answer about a citation',
    request: 'jaki tytuł ma praca cytowana w dokumencie jako greenwade93?',
    tools: [[AgentTool.ReadFile], [AgentTool.Search], [AgentTool.Search, AgentTool.ReadFile]],
    answer: /Comprehensive|CTAN/i,
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'reads the bibliography before adding an entry to it',
    request: 'dodaj do sample.bib wpis książki Donald Knuth, The TeXbook, 1984, z kluczem knuth84',
    tools: [[AgentTool.ReadFile]],
    edit: {
      path: BIB,
      operation: 'insert_after',
      line: getText(TEXTS, BIB).lines.length,
      content: /@book\{knuth84,[\s\S]*TeXbook[\s\S]*\}$/,
    },
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'edits a file that is not open',
    request: 'w pliku chapters/results.tex zmień tytuł sekcji na Wyniki pomiarów',
    tools: [[AgentTool.ReadFile]],
    edit: {
      path: RESULTS,
      operation: 'replace',
      line: lineOf(RESULTS, '\\section{Results}'),
      content: /^\\section\{Wyniki pomiarów\}$/,
    },
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'searches the project for a label',
    request: 'w którym pliku i w której linii jest etykieta sec:results?',
    tools: [[AgentTool.Search]],
    answer: new RegExp(`chapters/results\\.tex[\\s\\S]*${String(lineOf(RESULTS, 'sec:results'))}`),
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'compiles, reads the broken file and fixes it',
    request: 'projekt się nie kompiluje, znajdź i napraw błąd',
    texts: BROKEN_TEXTS,
    diagnostics: BROKEN_DIAGNOSTICS,
    tools: [
      [AgentTool.Compile, AgentTool.ReadFile],
      [AgentTool.ReadFile, AgentTool.Compile],
      [AgentTool.ReadFile, AgentTool.Compile, AgentTool.ReadFile],
    ],
    edit: {
      path: RESULTS,
      operation: 'replace',
      line: BROKEN_LINE,
      content: /^\\begin\{tabular\}\{l\|r\}$/,
    },
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'says that a file named by the user does not exist',
    request: 'co jest w pliku appendix.tex?',
    tools: [[]],
    answer: /appendix\.tex/,
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'replies once the tools are used up',
    request: 'jaki tytuł ma praca cytowana w dokumencie jako greenwade93?',
    transcript: CLOSED_TRANSCRIPT,
    tools: [[]],
    answer: /Comprehensive|CTAN/i,
  },
];

function textFiles(
  texts: ReadonlyMap<string, DocumentSnapshot>,
): { path: string; document: DocumentSnapshot }[] {
  return [...texts].map(([path, document]) => ({ path, document }));
}

function runTool(c: Case, call: ToolCall): ToolResult {
  const { texts } = c;
  switch (call.tool) {
    case AgentTool.ReadFile:
      return { tool: call.tool, path: call.path, document: getText(texts, call.path) };
    case AgentTool.Search:
      return { tool: call.tool, ...searchProject(textFiles(texts), call.query) };
    case AgentTool.Compile:
      return { tool: call.tool, diagnostics: c.diagnostics };
  }
}

interface AgentRun {
  readonly reply: AgentReply;
  readonly tools: readonly ToolCall['tool'][];
  readonly usages: readonly ContextUsage[];
}

async function runAgent(agent: OllamaAgent, c: Case): Promise<AgentRun> {
  const { texts } = c;
  const workspace: AgentWorkspace = {
    files: FILES,
    openFile: { path: MAIN, document: getText(texts, MAIN) },
    cursorLine: 1,
    selection: c.selection,
  };
  const transcript: AgentTurn[] = [...c.transcript];
  const tools: ToolCall['tool'][] = [];
  const usages: ContextUsage[] = [];
  for (let step = 0; step <= AGENT_POLICY.maxToolCalls; step += 1) {
    const { decision, contextUsage } = await agent.decide({
      message: c.request,
      conversation: [],
      workspace,
      transcript,
    });
    usages.push(contextUsage);
    if (decision.kind === 'reply') return { reply: decision.reply, tools, usages };
    tools.push(decision.call.tool);
    transcript.push({ call: decision.call, result: runTool(c, decision.call) });
  }
  throw new TestFixtureError('the agent did not reply within its tool budget');
}

function gap(texts: ReadonlyMap<string, DocumentSnapshot>, edit: ExpectedEdit): number {
  const document = getText(texts, edit.path);
  let at = edit.operation === 'insert_before' ? edit.line - 1 : edit.line;
  while (at > 0 && document.lines[at - 1]?.trim() === '') at -= 1;
  return at;
}

function createContractAgent(): OllamaAgent {
  const client = new OllamaClient(
    {
      endpoint: requireEnv('OLLAMA_CONTRACT_URL'),
      model: requireEnv('OLLAMA_CONTRACT_MODEL'),
      contextTokens: Number(requireEnv('OLLAMA_CONTRACT_CONTEXT_TOKENS')),
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
    (input, init) => fetch(input, init),
  );
  return new OllamaAgent(client);
}

describe.runIf(OLLAMA_URL)('Ollama agent contract', () => {
  let agent: OllamaAgent;

  beforeAll(() => {
    agent = createContractAgent();
  });

  it.each(CASES)(
    '$name',
    async (c) => {
      const { reply, tools, usages } = await runAgent(agent, c);
      for (const usage of usages) {
        expect(usage.promptTokens).toBeGreaterThan(0);
        expect(usage.promptTokens).toBeLessThanOrEqual(usage.contextTokens);
      }
      if (c.tools) expect(c.tools).toContainEqual(tools);
      if (c.answer) {
        expect(reply.kind).toBe('answer');
        if (reply.kind === 'answer') expect(reply.text).toMatch(c.answer);
      }
      const expected = c.edit;
      if (expected === undefined) return;
      expect(reply.kind).toBe('edit');
      if (reply.kind !== 'edit') return;
      expect(reply.change.path).toBe(expected.path);
      const { command } = reply.change.edit;
      const { texts } = c;
      if (expected.operation.startsWith('insert') && command.operation.startsWith('insert')) {
        const actual = {
          ...expected,
          operation: command.operation,
          line: command.target.lineNumber,
        };
        expect(gap(texts, actual)).toBe(gap(texts, expected));
      } else {
        expect(command.operation).toBe(expected.operation);
        expect(command.target.lineNumber).toBe(expected.line);
      }
      if (
        expected.lastLines &&
        (command.operation === 'replace' || command.operation === 'delete')
      ) {
        expect(expected.lastLines).toContain(command.target.lineNumber + command.lineCount - 1);
      }
      if (expected.content) {
        expect('content' in command ? command.content : '').toMatch(expected.content);
      }
    },
    CASE_TIMEOUT_MS,
  );
});
