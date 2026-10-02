import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentProgress } from '../../src/application/agent-progress';
import { ConversationCompactor } from '../../src/application/conversation-compactor';
import { ConversationLog } from '../../src/application/conversation-log';
import type { AgentResult } from '../../src/application/conversation-agent';
import { OperationLock } from '../../src/application/operation-lock';
import { WebSearchApproval, WebSearchDecision } from '../../src/application/web-search-approval';
import { WebSearchTool } from '../../src/application/web-search-tool';
import { PendingChanges } from '../../src/application/pending-change';
import { AgentTool, type ToolCall } from '../../src/domain/agent-action';
import { MAIN_AGENT_POLICY, WEB_POLICIES } from '../support/policies';
import type { AgentTurn, CompileDiagnostic } from '../../src/domain/agent-transcript';
import { createDocumentSnapshot, type DocumentSnapshot } from '../../src/domain/document';
import type { DocumentOperation } from '../../src/domain/document-command';
import { searchProject } from '../../src/domain/project-search';
import type { WebSearchResult } from '../../src/domain/web-search';
import { OllamaAgent } from '../../src/infrastructure/ollama/ollama-agent';
import { OllamaClient } from '../../src/infrastructure/ollama/ollama-client';
import { OllamaSummarizer } from '../../src/infrastructure/ollama/ollama-summarizer';
import { parseExaSearchResults } from '../../src/infrastructure/mcp/exa-search-results';
import type { ConversationMessage, ImportedHistory } from '../../src/domain/conversation';
import type { ContextUsage } from '../../src/domain/context-usage';
import type { AgentPort } from '../../src/ports/agent-port';
import {
  EMPTY_CONVERSATION,
  FakeEditor,
  FakeProject,
  FakeWebSearch,
  InMemorySessionRepository,
  sequentialIds,
  storedSession,
  ticking,
} from '../support/fakes';
import { itemAt, textMatching } from '../support/guards';
import { readExaSearchFixture } from '../support/fake-mcp-server';
import { TestFixtureError } from '../support/test-errors';
import { composeRequestHandling } from '../support/request-handling';

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
  readonly webSearch?: WebSearchDecision;
  readonly texts: ReadonlyMap<string, DocumentSnapshot>;
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly selection: string;
  readonly showsBinaryFile?: boolean;
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

const CHAPTER_TOPICS = [
  'Wprowadzenie',
  'Przegląd literatury',
  'Metodyka',
  'Eksperymenty',
  'Wyniki',
  'Dyskusja',
];
const DEFINED_KEYS = [
  'breiman01',
  'cortes95',
  'hastie09',
  'bishop06',
  'lecun15',
  'goodfellow16',
  'murphy12',
  'vapnik98',
  'friedman01',
  'rumelhart86',
  'hinton06',
  'schmidhuber15',
];
const MISSING_KEYS = ['quinlan86', 'mitchell97'];

function citedKey(chapter: number, paragraph: number): string {
  if (chapter === 2 && paragraph === 4) return itemAt(MISSING_KEYS, 0, 'missing key');
  if (chapter === 4 && paragraph === 1) return itemAt(MISSING_KEYS, 1, 'missing key');
  return itemAt(DEFINED_KEYS, (chapter * 5 + paragraph) % DEFINED_KEYS.length, 'defined key');
}

function chapterText(chapter: number): DocumentSnapshot {
  const topic = itemAt(CHAPTER_TOPICS, chapter, 'chapter topic');
  return createDocumentSnapshot([
    `\\chapter{${topic}}`,
    `\\label{chap:${String(chapter + 1)}}`,
    '',
    ...Array.from({ length: 7 }, (_, paragraph) => [
      `W tym akapicie rozdziału ${topic.toLowerCase()} omawiamy zagadnienie numer ${String(paragraph + 1)}, porównując podejścia klasyczne z nowszymi metodami uczenia maszynowego, co szczegółowo opisano w pracy~\\cite{${citedKey(chapter, paragraph)}}.`,
      `Dodatkowe uwagi do zagadnienia ${String(paragraph + 1)} dotyczą doboru hiperparametrów, walidacji krzyżowej oraz interpretacji uzyskanych wyników w kontekście całej pracy.`,
      '',
    ]).flat(),
  ]);
}

const CITATION_TEXTS: ReadonlyMap<string, DocumentSnapshot> = new Map([
  [
    MAIN,
    createDocumentSnapshot([
      '\\documentclass{report}',
      '\\begin{document}',
      '\\title{Praca dyplomowa}',
      '\\maketitle',
      ...CHAPTER_TOPICS.map((_, chapter) => `\\include{chapters/ch${String(chapter + 1)}}`),
      '\\bibliographystyle{plain}',
      '\\bibliography{refs}',
      '\\end{document}',
    ]),
  ],
  ...CHAPTER_TOPICS.map((_, chapter): [string, DocumentSnapshot] => [
    `chapters/ch${String(chapter + 1)}.tex`,
    chapterText(chapter),
  ]),
  [
    'refs.bib',
    createDocumentSnapshot(
      DEFINED_KEYS.flatMap((key) => [
        `@article{${key},`,
        `  author = {Author of ${key}},`,
        `  title = {Work ${key}},`,
        `  year = {20${key.slice(-2)}}`,
        '}',
        '',
      ]),
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
    showsBinaryFile: true,
    name: 'edits a named file while the editor shows an image',
    request: 'In main.tex, make the caption of the frog figure more descriptive.',
    edit: {
      path: MAIN,
      operation: 'replace',
      line: lineOf(MAIN, '\\caption{\\label{fig:frog}'),
      content: /^\\caption\{\\label\{fig:frog\}[^\n]+\}$/,
    },
  },
  {
    ...UNTOUCHED_PROJECT,
    showsBinaryFile: true,
    name: 'answers a question while the editor shows an image',
    request: 'Which bibliography style does the project use?',
    answer: /plain|alpha/i,
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
  'awaiting-approval': AgentTool.WebSearch,
};

function readWebResults(): readonly WebSearchResult[] {
  const { content } = readExaSearchFixture();
  if (!Array.isArray(content)) throw new TestFixtureError('the Exa fixture has no content');
  return parseExaSearchResults(
    content.map((item: unknown) => {
      if (typeof item !== 'object' || item === null || !('text' in item)) {
        throw new TestFixtureError('the Exa fixture holds content without text');
      }
      return String(item.text);
    }),
  );
}

const WEB_RESULTS = readWebResults();

interface ApplicationRun {
  readonly result: AgentResult;
  readonly tools: readonly ToolCall['tool'][];
  readonly usages: readonly ContextUsage[];
  readonly project: FakeProject;
  readonly conversation: readonly ConversationMessage[];
  readonly webQueries: readonly string[];
}

function createProject(editor: FakeEditor, texts: ReadonlyMap<string, DocumentSnapshot>) {
  const documents = Object.fromEntries([...texts].map(([path, { lines }]) => [path, lines]));
  return new FakeProject(editor, documents, MAIN, BINARY_PATHS);
}

async function runApplication(
  { agent, summarizer }: ContractModel,
  c: Case,
  history: readonly ConversationMessage[] = [],
  imported: ImportedHistory | null = null,
): Promise<ApplicationRun> {
  const editor = new FakeEditor([]);
  editor.selection = c.selection;
  const project = createProject(editor, c.texts);
  if (c.showsBinaryFile === true) project.showBinaryFile(itemAt(BINARY_PATHS, 0, 'binary file'));
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
  if (history.length > 0) conversation.show({ ...storedSession('history', history), imported });
  const newId = sequentialIds();
  const webSearch = new FakeWebSearch().will(WEB_RESULTS, WEB_RESULTS, WEB_RESULTS);
  const approval = new WebSearchApproval({ conversation, newId });
  const { handleRequest } = composeRequestHandling({
    agent: recordingAgent,
    project,
    editor,
    conversation,
    pendingChanges: new PendingChanges({ conversation, editor }),
    lock: new OperationLock(() => new AbortController()),
    newId,
    webSearch: new WebSearchTool({ search: webSearch, approval }),
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
    if (progress.stage === 'awaiting-approval') {
      approval.decide(progress.search.id, c.webSearch ?? WebSearchDecision.Approve);
    }
  });
  return {
    result,
    tools,
    usages,
    project,
    conversation: conversation.messages(),
    webQueries: webSearch.queries,
  };
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

const ABSTRACT_LINE = lineOf(MAIN, 'Your abstract.');
const AUTHOR_LINE = lineOf(MAIN, '\\author{');
const POLISH_TEXTS: ReadonlyMap<string, DocumentSnapshot> = new Map([
  ...TEXTS,
  [
    MAIN,
    createDocumentSnapshot(
      getText(TEXTS, MAIN).lines.map((line, index) =>
        index + 1 === TITLE_LINE ? '\\title{Raport z laboratorium}' : line,
      ),
    ),
  ],
]);
const POLISH_HISTORY: readonly ConversationMessage[] = [
  { id: 'pl-0', role: 'user', text: 'Kompilacja się wysypuje, napraw błędy.' },
  {
    id: 'pl-1',
    role: 'assistant',
    kind: 'explanation',
    text: 'Projekt kompiluje się bez błędów, więc nie ma czego poprawiać.',
  },
];
const POLISH_WORDS = /[ąćęłńóśźż]|\b(się|jest|nie|mogę|dodaję|zmieniam|pomóc|cześć|witaj)\b/i;
const POLISH_REASON = /[ąćęłńóśźż]|\b(usuwam|usunięcie|akapit|akapitu)\b/i;
const ENGLISH_WORDS = /\b(the|you|is|are|and|help|hello|hi|this|to)\b/i;

const UNDONE_ABSTRACT = 'This report describes a physics lab experiment.';
const UNDONE_ABSTRACT_HISTORY: readonly ConversationMessage[] = [
  { id: 'a-s', role: 'user', text: 'Cześć! Wyjaśnij krótko strukturę dokumentu.' },
  {
    id: 'a-t',
    role: 'assistant',
    kind: 'explanation',
    text: 'Dokument ma tytuł, abstrakt, wstęp i sekcję z przykładami: rysunkiem, tabelą, listami, wzorami i bibliografią.',
  },
  { id: 'a-0', role: 'user', text: `Zmień abstrakt na: ${UNDONE_ABSTRACT}` },
  {
    id: 'a-1',
    role: 'assistant',
    kind: 'proposal',
    edits: [
      {
        path: MAIN,
        command: {
          operation: 'replace',
          target: { lineNumber: ABSTRACT_LINE, lineText: 'Your abstract.' },
          lineCount: 1,
          content: UNDONE_ABSTRACT,
          reason: 'Zmieniam abstrakt.',
        },
        status: 'undone',
      },
    ],
  },
  { id: 'a-2', role: 'undo', proposalId: 'a-1', undone: [MAIN], refused: [] },
  { id: 'a-3', role: 'user', text: 'Zmień autora na Anna Nowak.' },
  {
    id: 'a-4',
    role: 'assistant',
    kind: 'proposal',
    edits: [
      {
        path: MAIN,
        command: {
          operation: 'replace',
          target: { lineNumber: AUTHOR_LINE, lineText: '\\author{You}' },
          lineCount: 1,
          content: '\\author{Anna Nowak}',
          reason: 'Zmieniam autora.',
        },
        status: 'rejected',
      },
    ],
  },
];
const LOREM_SENTENCES = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
];
const LOREM_TEXT = Array.from({ length: 280 }, (_, index) =>
  itemAt(LOREM_SENTENCES, index % LOREM_SENTENCES.length, 'sentence'),
).join(' ');

const LAMPORT_REQUEST = "Find the DOI of Lamport's LaTeX book on the web.";
const DENIED_SEARCH_HISTORY: readonly ConversationMessage[] = [
  { id: 'w-0', role: 'user', text: LAMPORT_REQUEST },
  {
    id: 'w-1',
    role: 'tool',
    record: {
      tool: AgentTool.WebSearch,
      query: 'Leslie Lamport LaTeX A Document Preparation System DOI',
      outcome: { status: 'denied' },
    },
  },
  {
    id: 'w-2',
    role: 'assistant',
    kind: 'explanation',
    text: 'You denied the web search, so I could not look up the DOI of the book.',
  },
];

const ESCAPED_ABSTRACT_REQUEST =
  'Set the abstract to this text exactly, escaped for LaTeX: Costs rose 50% & fell; see C:\\temp\\data_1 ~ok, x^2, #3 {a} — end.';

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
    'delegates a check of every citation across the chapters and answers from its findings',
    async () => {
      const run = await runApplication(model, {
        ...UNTOUCHED_PROJECT,
        texts: CITATION_TEXTS,
        name: 'citation check',
        request:
          'Sprawdź, czy każdy klucz \\cite we wszystkich rozdziałach w chapters/ jest zdefiniowany w refs.bib, i wypisz brakujące klucze.',
      });
      expect(run.tools).toContain(AgentTool.Delegate);
      const delegations = run.conversation.filter(
        (message) => message.role === 'tool' && message.record.tool === AgentTool.Delegate,
      );
      expect(delegations.length).toBeGreaterThan(0);
      expect(run.result.message).toMatchObject({
        kind: 'explanation',
        text: textMatching(/^(?=[\s\S]*quinlan86)(?=[\s\S]*mitchell97)/),
      });
      for (const usage of run.usages) {
        expect(usage.promptTokens).toBeLessThanOrEqual(usage.contextTokens);
      }
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
        policy: WEB_POLICIES.main,
        conversation: EMPTY_CONVERSATION,
        workspace: {
          files: project.files,
          openFile: {
            kind: 'text',
            path: MAIN,
            document: getText(TEXTS, MAIN),
            cursorLine: 1,
            selection: '',
          },
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

  const LAMPORT_ENTRY = {
    first: lineOf(BIB, '@book{lamport94,'),
    last: lineOf(BIB, 'publisher = "Addison-Wesley"') + 1,
  };
  const FOUND_DOI = /doi\s*=\s*[{"]\s*10\.5555\/63364\s*[}"]/i;

  it(
    'searches the web for a missing DOI and adds it to the entry in the bibliography',
    async () => {
      const run = await runApplication(model, {
        ...UNTOUCHED_PROJECT,
        name: 'DOI from the web',
        request: "find the DOI of Lamport's LaTeX book and add it to sample.bib",
      });
      expect(run.tools).toContain(AgentTool.WebSearch);
      expect(run.tools.filter((tool) => tool === AgentTool.WebSearch)).toHaveLength(
        run.webQueries.length,
      );
      for (const query of run.webQueries) {
        expect(query).toMatch(/LaTeX|Lamport/i);
        expect(query.length).toBeLessThanOrEqual(200);
      }
      expect(run.result.kind).toBe('proposal');
      if (run.result.kind !== 'proposal') return;
      const [edit, ...others] = run.result.message.edits;
      expect(others).toEqual([]);
      expect(edit?.path).toBe(BIB);
      const line = edit?.command.target.lineNumber ?? 0;
      expect(line).toBeGreaterThanOrEqual(LAMPORT_ENTRY.first);
      expect(line).toBeLessThanOrEqual(LAMPORT_ENTRY.last);
      expect(edit?.command).toMatchObject({ content: textMatching(FOUND_DOI) });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'answers from the web results with a source that appears in them',
    async () => {
      const run = await runApplication(model, {
        ...UNTOUCHED_PROJECT,
        name: 'DOI answer from the web',
        request: 'jaki jest DOI książki Lamporta o LaTeX-u? sprawdź w internecie i podaj źródło',
      });
      expect(run.tools[0]).toBe(AgentTool.WebSearch);
      expect(run.result.message).toMatchObject({
        kind: 'explanation',
        text: textMatching(/^(?=[\s\S]*10\.5555\/63364)(?=[\s\S]*dl\.acm\.org)/),
      });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'goes on without the web after the user denies the search and invents no DOI',
    async () => {
      const run = await runApplication(model, {
        ...UNTOUCHED_PROJECT,
        name: 'denied web search',
        request: "find the DOI of Lamport's LaTeX book and add it to sample.bib",
        webSearch: WebSearchDecision.Deny,
      });
      expect(run.tools.filter((tool) => tool === AgentTool.WebSearch)).toHaveLength(1);
      expect(run.webQueries).toEqual([]);
      expect(run.result.kind).toBe('reply');
      expect(run.result.message).not.toMatchObject({ text: textMatching(/10\.\d{4,}\//) });
    },
    CASE_TIMEOUT_MS,
  );
  it(
    'answers a long summary request instead of re-proposing an undone edit',
    async () => {
      const run = await runApplication(
        model,
        {
          ...UNTOUCHED_PROJECT,
          name: 'long summary request',
          request: `Przeczytaj ten tekst i powiedz w jednym zdaniu o czym jest. ${LOREM_TEXT}`,
        },
        UNDONE_ABSTRACT_HISTORY,
        { path: 'hans-sessions/earlier.json', lastMessageId: 'a-4' },
      );
      expect(run.result.message).toMatchObject({ kind: 'explanation' });
      expect(run.result.message).not.toMatchObject({
        text: textMatching(/physics lab experiment/i),
      });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'greets in English in a new session although the document is Polish',
    async () => {
      const run = await runApplication(model, {
        ...UNTOUCHED_PROJECT,
        texts: POLISH_TEXTS,
        name: 'English greeting',
        request: 'Hello',
      });
      expect(run.result.message).toMatchObject({ text: textMatching(ENGLISH_WORDS) });
      expect(run.result.message).not.toMatchObject({ text: textMatching(POLISH_WORDS) });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'answers an English question in English after Polish messages',
    async () => {
      const run = await runApplication(
        model,
        {
          ...UNTOUCHED_PROJECT,
          texts: POLISH_TEXTS,
          name: 'English question',
          request: 'Which packages does main.tex load and why?',
        },
        POLISH_HISTORY,
      );
      expect(run.result.message).toMatchObject({
        kind: 'explanation',
        text: textMatching(/graphicx/),
      });
      expect(run.result.message).not.toMatchObject({ text: textMatching(POLISH_WORDS) });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'gives the reason of an edit in the language of the request',
    async () => {
      const run = await runApplication(
        model,
        {
          ...UNTOUCHED_PROJECT,
          texts: POLISH_TEXTS,
          name: 'English edit reason',
          request: 'Change the author to Anna Nowak.',
        },
        POLISH_HISTORY,
      );
      expect(run.result.kind).toBe('proposal');
      if (run.result.kind !== 'proposal') return;
      for (const { command } of run.result.message.edits) {
        if (command.reason !== undefined) expect(command.reason).not.toMatch(POLISH_WORDS);
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'gives the reason of an edit in Polish for a Polish request',
    async () => {
      const run = await runApplication(model, {
        ...UNTOUCHED_PROJECT,
        name: 'Polish edit reason',
        request: 'usuń akapit o track changes',
      });
      expect(run.result.kind).toBe('proposal');
      if (run.result.kind !== 'proposal') return;
      for (const { command } of run.result.message.edits) {
        if (command.reason !== undefined) expect(command.reason).toMatch(POLISH_REASON);
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'asks to search the web again once the user allows what was denied',
    async () => {
      const run = await runApplication(
        model,
        {
          ...UNTOUCHED_PROJECT,
          name: 'search allowed after denial',
          request: `OK, now you may search the web. ${LAMPORT_REQUEST}`,
        },
        DENIED_SEARCH_HISTORY,
      );
      expect(run.tools).toContain(AgentTool.WebSearch);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'escapes LaTeX special characters of a text set exactly',
    async () => {
      const run = await runApplication(model, {
        ...UNTOUCHED_PROJECT,
        name: 'escaped abstract',
        request: ESCAPED_ABSTRACT_REQUEST,
      });
      expect(run.result.kind).toBe('proposal');
      if (run.result.kind !== 'proposal') return;
      const content = run.result.message.edits
        .map(({ command }) => ('content' in command ? command.content : ''))
        .join('\n');
      for (const escaped of [
        /50\\%/,
        /\\&/,
        /C:\\textbackslash(\{\}|\s)temp\\textbackslash(\{\}|\s)data\\_1/,
        /(\\textasciitilde(\{\}|\s)|\\~\{\})ok/,
        /x(\\textasciicircum(\{\}|\s)|\\\^\{\})2|\$x\^\{?2\}?\$/,
        /\\#3/,
        /\\\{a\\\}/,
        /---|—|\\textemdash\b/,
      ]) {
        expect(content).toMatch(escaped);
      }
      expect(content).not.toMatch(/\\[~^](?!\{\})|\\text\{—\}|\\backslash\b|\\\\/);
    },
    CASE_TIMEOUT_MS,
  );
});
