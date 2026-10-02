import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentProgress } from '../../src/application/agent-progress';
import { ConversationCompactor } from '../../src/application/conversation-compactor';
import { ConversationLog } from '../../src/application/conversation-log';
import {
  HandleAssistantRequest,
  type AgentResult,
} from '../../src/application/handle-assistant-request';
import { OperationLock } from '../../src/application/operation-lock';
import { PendingChanges } from '../../src/application/pending-change';
import { AgentTool, type ToolCall } from '../../src/domain/agent-action';
import { MAIN_AGENT_POLICY } from '../../src/domain/agent-policy';
import type { AgentTurn, CompileDiagnostic } from '../../src/domain/agent-transcript';
import { createDocumentSnapshot, type DocumentSnapshot } from '../../src/domain/document';
import type { DocumentOperation } from '../../src/domain/document-command';
import { searchProject } from '../../src/domain/project-search';
import { OllamaAgent } from '../../src/infrastructure/ollama/ollama-agent';
import { OllamaClient } from '../../src/infrastructure/ollama/ollama-client';
import { OllamaSummarizer } from '../../src/infrastructure/ollama/ollama-summarizer';
import type { ConversationMessage } from '../../src/domain/conversation';
import type { AgentPort, ContextUsage } from '../../src/ports/agent-port';
import {
  EMPTY_CONVERSATION,
  FakeEditor,
  FakeProject,
  InMemorySessionRepository,
  sequentialIds,
  storedSession,
  ticking,
} from '../support/fakes';
import { itemAt, textMatching } from '../support/guards';
import { TestFixtureError } from '../support/test-errors';

const CASE_TIMEOUT_MS = 600_000;
const STEP_TIMEOUT_MS = 300_000;

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

const BINARY_PATHS = ['frog.jpg'];

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
    message: `LaTeX Error: \\begin{table} on input line ${String(lineOf(RESULTS, '\\begin{table}'))} ended by \\end{tabular}.`,
    path: RESULTS,
    lineNumber: lineOf(RESULTS, '\\end{tabular}'),
  },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new TestFixtureError(`${name} must be set to run the contract with the live model`);
  }
  return value;
}

interface ExpectedEdit {
  readonly path: string;
  readonly operation: DocumentOperation;
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
  readonly tools?: readonly (readonly ToolCall['tool'][])[];
  readonly answer?: RegExp;
  readonly edit?: ExpectedEdit;
}

const CLOSED_TRANSCRIPT: readonly AgentTurn[] = [
  {
    kind: 'tool',
    call: { tool: AgentTool.ReadFile, path: BIB },
    result: {
      tool: AgentTool.ReadFile,
      path: BIB,
      document: getText(TEXTS, BIB),
      shown: { first: 1, last: getText(TEXTS, BIB).lines.length },
    },
  },
  ...['tabular', 'caption', 'section', 'label', 'figure'].map((query): AgentTurn => ({
    kind: 'tool',
    call: { tool: AgentTool.Search, query },
    result: { tool: AgentTool.Search, ...searchProject(textFiles(TEXTS), query) },
  })),
];

const MEASUREMENTS = 'chapters/measurements.tex';
const LONG_TEXTS: ReadonlyMap<string, DocumentSnapshot> = new Map([
  ...TEXTS,
  [
    MEASUREMENTS,
    createDocumentSnapshot(
      Array.from(
        { length: 3_000 },
        (_, index) =>
          `Pomiar ${String(index + 1)}: temperatura ${String(20 + (index % 7))} stopni, ciśnienie ${String(1_000 + (index % 13))} hPa.`,
      ),
    ),
  ],
]);

const UNTOUCHED_PROJECT = {
  texts: TEXTS,
  diagnostics: [],
  selection: '',
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
      content: /^(?![^]*Your introduction goes here)[^]*[ąćęłńóśźż]/i,
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
    tools: [[AgentTool.ReadFile], [AgentTool.Search, AgentTool.ReadFile]],
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
    tools: [[AgentTool.ReadFile], [AgentTool.Search, AgentTool.ReadFile]],
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
    tools: [[AgentTool.Search], [AgentTool.ReadFile]],
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
      content: /^\\begin\{tabular\}\{l\|r\}(?![^]*\\begn)/,
    },
  },
  {
    ...UNTOUCHED_PROJECT,
    name: 'says that a file named by the user does not exist',
    request: 'co jest w pliku appendix.tex?',
    tools: [[], [AgentTool.Search]],
    answer: /appendix\.tex[^]*\b(nie|brak)\b|\b(nie|brak)\b[^]*appendix\.tex/i,
  },
  {
    ...UNTOUCHED_PROJECT,
    texts: LONG_TEXTS,
    name: 'reads a far part of a long file before editing it',
    request: `w pliku ${MEASUREMENTS} zmień temperaturę w pomiarze 2600 na 35 stopni`,
    edit: {
      path: MEASUREMENTS,
      operation: 'replace',
      line: 2_600,
      content: /^Pomiar 2600: temperatura 35 stopni/,
    },
  },
];

const RESULTS_REFERENCE = 'Wyniki pomiarów opisuje rozdział~\\ref{sec:results}.';
const REFERENCED_TEXTS: ReadonlyMap<string, DocumentSnapshot> = new Map([
  ...TEXTS,
  [
    MAIN,
    createDocumentSnapshot(
      getText(TEXTS, MAIN).lines.flatMap((line) =>
        line === '\\input{chapters/results}' ? [RESULTS_REFERENCE, '', line] : [line],
      ),
    ),
  ],
]);

const TITLE_LINE = lineOf(MAIN, '\\title{');
const UNDONE_TITLE_HISTORY: readonly ConversationMessage[] = [
  { id: 'u-0', role: 'user', text: 'zmień tytuł na Raport z laboratorium' },
  {
    id: 'p-0',
    role: 'assistant',
    kind: 'proposal',
    edits: [
      {
        path: MAIN,
        command: {
          operation: 'replace',
          target: { lineNumber: TITLE_LINE, lineText: lineText(MAIN, TITLE_LINE) },
          lineCount: 1,
          content: '\\title{Raport z laboratorium}',
        },
        status: 'undone',
      },
    ],
  },
  { id: 'n-0', role: 'undo', proposalId: 'p-0', undone: [MAIN], refused: [] },
];

const FILLER_TOPICS = [
  'tabel z biblioteką booktabs',
  'rysunków z pakietem graphicx',
  'bibliografii w BibTeX',
  'wzorów w środowisku align',
  'odsyłaczy \\label i \\ref',
  'list wypunktowanych',
  'stron tytułowych',
  'przypisów dolnych',
];

function fillerAnswer(turn: number): string {
  const topic = itemAt(FILLER_TOPICS, turn % FILLER_TOPICS.length, 'topic');
  return Array.from(
    { length: 12 },
    (_, index) =>
      `Krok ${String(index + 1)} dotyczący ${topic}: w LaTeX-u warto trzymać spójny styl, opisywać każdy element podpisem i odwoływać się do niego w tekście, a po każdej zmianie skompilować dokument i sprawdzić ostrzeżenia w dzienniku.`,
  ).join(' ');
}

const PROJECT_CODE = /HX[\p{Pd}\s]?42/u;

const LONG_CONVERSATION: readonly ConversationMessage[] = [
  {
    id: 'h-0-user',
    role: 'user',
    text: 'Zapamiętaj na całą rozmowę: skrót projektu to HX-42, a wszystkie wykresy mają mieć kolor butelkowej zieleni.',
  },
  {
    id: 'h-0-answer',
    role: 'assistant',
    kind: 'explanation',
    text: 'Zapamiętane: skrót projektu HX-42, wykresy w kolorze butelkowej zieleni.',
  },
  ...Array.from({ length: 50 }, (_, turn): ConversationMessage[] => [
    {
      id: `h-${String(turn + 1)}-user`,
      role: 'user',
      text: `Wyjaśnij krok po kroku dobre praktyki dotyczące ${itemAt(FILLER_TOPICS, turn % FILLER_TOPICS.length, 'topic')}.`,
    },
    {
      id: `h-${String(turn + 1)}-answer`,
      role: 'assistant',
      kind: 'explanation',
      text: fillerAnswer(turn),
    },
  ]).flat(),
];

function textFiles(
  texts: ReadonlyMap<string, DocumentSnapshot>,
): { path: string; document: DocumentSnapshot }[] {
  return [...texts].map(([path, document]) => ({ path, document }));
}

const TOOL_OF_PROGRESS: Partial<Record<AgentProgress['stage'], ToolCall['tool']>> = {
  reading: AgentTool.ReadFile,
  searching: AgentTool.Search,
  compiling: AgentTool.Compile,
  delegating: AgentTool.Delegate,
};

interface ApplicationRun {
  readonly result: AgentResult;
  readonly tools: readonly ToolCall['tool'][];
  readonly usages: readonly ContextUsage[];
  readonly project: FakeProject;
  readonly conversation: readonly ConversationMessage[];
}

function createProject(editor: FakeEditor, texts: ReadonlyMap<string, DocumentSnapshot>) {
  const documents = Object.fromEntries([...texts].map(([path, { lines }]) => [path, lines]));
  return new FakeProject(editor, documents, MAIN, BINARY_PATHS);
}

async function runApplication(
  { agent, summarizer }: ContractModel,
  c: Case,
  history: readonly ConversationMessage[] = [],
): Promise<ApplicationRun> {
  const editor = new FakeEditor([]);
  editor.selection = c.selection;
  const project = createProject(editor, c.texts);
  project.willCompile(
    ...Array.from({ length: MAIN_AGENT_POLICY.maxToolCalls }, () => c.diagnostics),
  );
  const usages: ContextUsage[] = [];
  const recordingAgent: AgentPort = {
    idleUsage: agent.idleUsage,
    planCompaction: (trigger) => agent.planCompaction(trigger),
    measureConversation: (conversation) => agent.measureConversation(conversation),
    async decide(request) {
      const step = await agent.decide(request);
      usages.push(step.contextUsage);
      return step;
    },
    async decideShortened(request) {
      const step = await agent.decideShortened(request);
      usages.push(step.contextUsage);
      return step;
    },
  };
  const conversation = new ConversationLog({
    sessions: new InMemorySessionRepository(),
    newId: sequentialIds('session'),
    now: ticking(),
  });
  if (history.length > 0) conversation.show(storedSession('history', history));
  const newId = sequentialIds();
  const handleRequest = new HandleAssistantRequest({
    agent: recordingAgent,
    project,
    editor,
    conversation,
    pendingChanges: new PendingChanges(conversation),
    lock: new OperationLock(() => new AbortController()),
    newId,
    createController: () => new AbortController(),
    compactor: new ConversationCompactor({
      agent: recordingAgent,
      summarizer,
      conversation,
      newId,
      now: () => new Date(),
    }),
  });
  const tools: ToolCall['tool'][] = [];
  const result = await handleRequest.execute(c.request, (progress) => {
    const tool = TOOL_OF_PROGRESS[progress.stage];
    if (tool !== undefined) tools.push(tool);
  });
  return { result, tools, usages, project, conversation: conversation.messages() };
}

function gap(texts: ReadonlyMap<string, DocumentSnapshot>, edit: ExpectedEdit): number {
  const document = getText(texts, edit.path);
  let at = edit.operation === 'insert_before' ? edit.line - 1 : edit.line;
  while (at > 0 && document.lines[at - 1]?.trim() === '') at -= 1;
  return at;
}

interface ContractModel {
  readonly agent: OllamaAgent;
  readonly summarizer: OllamaSummarizer;
}

function createContractModel(): ContractModel {
  const client = new OllamaClient(
    {
      endpoint: requireEnv('OLLAMA_CONTRACT_URL'),
      model: requireEnv('OLLAMA_CONTRACT_MODEL'),
      stepTimeoutMs: STEP_TIMEOUT_MS,
    },
    (input, init) => fetch(input, init),
  );
  return { agent: new OllamaAgent(client), summarizer: new OllamaSummarizer(client) };
}

function expectEdit(
  texts: ReadonlyMap<string, DocumentSnapshot>,
  run: ApplicationRun,
  expected: ExpectedEdit,
): void {
  const { result } = run;
  expect(result.kind).toBe('proposal');
  if (result.kind !== 'proposal') return;
  expect(result.message.edits).toHaveLength(1);
  const [edit] = result.message.edits;
  if (edit === undefined) return;
  expect(edit.path).toBe(expected.path);
  const { command } = edit;
  if (expected.operation.startsWith('insert') && command.operation.startsWith('insert')) {
    const actual = { ...expected, operation: command.operation, line: command.target.lineNumber };
    expect(gap(texts, actual)).toBe(gap(texts, expected));
  } else {
    expect(command.operation).toBe(expected.operation);
    expect(command.target.lineNumber).toBe(expected.line);
  }
  if (expected.lastLines && (command.operation === 'replace' || command.operation === 'delete')) {
    expect(expected.lastLines).toContain(command.target.lineNumber + command.lineCount - 1);
  }
  if (expected.content) {
    expect(command).toMatchObject({ content: textMatching(expected.content) });
  }
}

describe('Ollama agent contract', () => {
  let model: ContractModel;

  beforeAll(() => {
    model = createContractModel();
  });

  it.each(CASES)(
    '$name',
    async (c) => {
      const run = await runApplication(model, c);
      for (const usage of run.usages) {
        expect(usage.promptTokens).toBeGreaterThan(0);
        expect(usage.promptTokens).toBeLessThanOrEqual(usage.contextTokens);
      }
      if (c.tools) expect(c.tools).toContainEqual(run.tools);
      if (c.answer) {
        expect(run.result.message).toMatchObject({
          kind: 'explanation',
          text: textMatching(c.answer),
        });
      }
      if (c.edit) expectEdit(c.texts, run, c.edit);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'renames a label and its reference in another file in one change',
    async () => {
      const run = await runApplication(model, {
        ...UNTOUCHED_PROJECT,
        texts: REFERENCED_TEXTS,
        name: 'label rename',
        request:
          'zmień etykietę sec:results na sec:measurements i popraw wszystkie odwołania do niej',
      });
      expect(run.result.kind).toBe('proposal');
      if (run.result.kind !== 'proposal') return;
      const edits = run.result.message.edits.map(({ path, command }) => ({
        path,
        line: command.target.lineNumber,
        content: 'content' in command ? command.content : '',
      }));
      const referenceLine = getText(REFERENCED_TEXTS, MAIN).lines.indexOf(RESULTS_REFERENCE) + 1;
      expect(edits).toHaveLength(2);
      expect(edits).toContainEqual({
        path: RESULTS,
        line: lineOf(RESULTS, '\\label{sec:results}'),
        content: textMatching(/^\\label\{sec:measurements\}$/),
      });
      expect(edits).toContainEqual({
        path: MAIN,
        line: referenceLine,
        content: textMatching(/\\ref\{sec:measurements\}/),
      });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'knows that an undone change is no longer in the document',
    async () => {
      const run = await runApplication(
        model,
        {
          ...UNTOUCHED_PROJECT,
          name: 'undone title',
          request: 'Jaki tytuł ma teraz dokument? Odpowiedz krótko.',
        },
        UNDONE_TITLE_HISTORY,
      );
      expect(run.result.message).toMatchObject({
        kind: 'explanation',
        text: textMatching(/Your Paper/),
      });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'replies once the tools are used up',
    async () => {
      const project = createProject(new FakeEditor([]), TEXTS);
      const { decision } = await model.agent.decide({
        request: {
          kind: 'user',
          message: {
            id: 'r',
            role: 'user',
            text: 'jaki tytuł ma praca cytowana w dokumencie jako greenwade93?',
          },
        },
        conversation: EMPTY_CONVERSATION,
        workspace: {
          files: project.files,
          openFile: { path: MAIN, document: getText(TEXTS, MAIN) },
          cursorLine: 1,
          selection: '',
        },
        transcript: CLOSED_TRANSCRIPT,
        signal: new AbortController().signal,
      });
      expect(decision).toMatchObject({
        kind: 'reply',
        reply: { kind: 'answer', text: textMatching(/Comprehensive|CTAN/i) },
      });
    },
    CASE_TIMEOUT_MS,
  );
  it(
    'compacts a long conversation on its own and still answers from it',
    async () => {
      const run = await runApplication(
        model,
        {
          ...UNTOUCHED_PROJECT,
          name: 'long conversation',
          request: 'Jaki skrót projektu i jaki kolor wykresów ustaliłem na samym początku rozmowy?',
        },
        LONG_CONVERSATION,
      );
      const summaries = run.conversation.filter((message) => message.role === 'summary');
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ text: textMatching(PROJECT_CODE) });
      expect(run.result.message).toMatchObject({
        kind: 'explanation',
        text: textMatching(PROJECT_CODE),
      });
      expect(run.result.message).toMatchObject({
        text: textMatching(/butelk|zielon|zieleń|bottle/i),
      });
      for (const usage of run.usages) {
        expect(usage.promptTokens).toBeLessThanOrEqual(usage.contextTokens);
      }
    },
    CASE_TIMEOUT_MS,
  );
});
