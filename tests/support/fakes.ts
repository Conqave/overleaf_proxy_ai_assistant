import type { AgentDecision } from '../../src/domain/agent-action';
import type { CompileDiagnostic } from '../../src/domain/agent-transcript';
import { isRequestMessage, type ConversationMessage } from '../../src/domain/conversation';
import {
  createDocumentSnapshot,
  isSameDocument,
  type DocumentSnapshot,
} from '../../src/domain/document';
import type { FileChange } from '../../src/domain/file-change';
import {
  createProjectFiles,
  findTextFile,
  ProjectFileKind,
  type ProjectFile,
  type TextFile,
} from '../../src/domain/project-file';
import type { ResolvedEdit } from '../../src/domain/resolved-edit';
import { summarizeSession, type ConversationSession } from '../../src/domain/session';
import type {
  AgentPort,
  AgentStep,
  AgentStepRequest,
  CompactionPlan,
  CompactionTrigger,
} from '../../src/ports/agent-port';
import type {
  ConversationSummarizer,
  SummaryRequest,
} from '../../src/ports/conversation-summarizer';
import type { ConversationView } from '../../src/domain/conversation-view';
import type { CancellationSignal } from '../../src/ports/cancellation';
import type { SessionListing, SessionRepository } from '../../src/ports/session-repository';
import type { SessionArchive } from '../../src/ports/session-archive';
import type { SessionExport } from '../../src/domain/session-export';
import type { EditorPort } from '../../src/ports/editor-port';
import type { ProjectPort } from '../../src/ports/project-port';
import type { WebSearchPort } from '../../src/ports/web-search-port';
import type { WebSearchResult } from '../../src/domain/web-search';
import {
  EditorShowsOtherFileError,
  EditorUnavailableError,
  SessionNotFoundError,
  SessionStorageError,
  UnreadableSessionError,
} from '../../src/ports/errors';
import { TestFixtureError, UnexpectedFakeCallError } from './test-errors';

export class FakeEditor implements EditorPort {
  available = true;
  selection = '';
  cursorLine = 1;
  preview: readonly ResolvedEdit[] | null = null;
  applyFailure: Error | null = null;
  previewFailure: Error | null = null;
  applied: FileChange[] = [];
  shownFileId = '';

  constructor(public lines: string[]) {}

  readDocument(file: TextFile): DocumentSnapshot {
    this.ensureShowing(file);
    return createDocumentSnapshot(this.lines);
  }
  readSelection(file: TextFile): string {
    this.ensureShowing(file);
    return this.selection;
  }
  readCursorLine(file: TextFile): number {
    this.ensureShowing(file);
    return this.cursorLine;
  }
  showPreview(file: TextFile, edits: readonly ResolvedEdit[]): void {
    this.ensureShowing(file);
    if (this.previewFailure) throw this.previewFailure;
    this.preview = edits;
  }
  clearPreview(): void {
    this.preview = null;
  }
  apply(file: TextFile, change: FileChange): void {
    this.ensureShowing(file);
    if (this.applyFailure) throw this.applyFailure;
    if (!isSameDocument(change.before, createDocumentSnapshot(this.lines))) {
      throw new TestFixtureError(`the change was not made for the shown ${file.path}`);
    }
    this.lines = [...change.after.lines];
    this.applied.push(change);
  }
  private ensureShowing(file: TextFile): void {
    if (!this.available) throw new EditorUnavailableError('no editor');
    if (file.id !== this.shownFileId) throw new EditorShowsOtherFileError(`not ${file.path}`);
  }
}

export class PendingStep<T> {
  constructor(readonly settle: (signal: CancellationSignal) => Promise<T>) {}
}

type Step<T> = T | Error | PendingStep<T>;

export const FAKE_CONTEXT_TOKENS = 98_304;

export function agentStep(decision: AgentDecision, promptTokens = 1_000): AgentStep {
  return {
    decision,
    contextUsage: {
      contextTokens: FAKE_CONTEXT_TOKENS,
      promptTokens,
      pressure: 'low',
    },
  };
}

export class FakeAgent implements AgentPort {
  readonly idleUsage = {
    contextTokens: FAKE_CONTEXT_TOKENS,
    promptTokens: 0,
    pressure: 'low',
  } as const;
  requests: AgentStepRequest[] = [];
  shortened: boolean[] = [];
  triggers: CompactionTrigger[] = [];
  plan: (trigger: CompactionTrigger) => CompactionPlan | null = () => null;
  onDecide: (request: AgentStepRequest) => void = () => undefined;
  private decisions: Step<AgentDecision>[] = [];

  will(...decisions: Step<AgentDecision>[]): this {
    this.decisions.push(...decisions);
    return this;
  }
  async decide(request: AgentStepRequest): Promise<AgentStep> {
    this.shortened.push(false);
    return await this.step(request);
  }
  async decideShortened(request: AgentStepRequest): Promise<AgentStep> {
    this.shortened.push(true);
    return await this.step(request);
  }
  private async step(request: AgentStepRequest): Promise<AgentStep> {
    this.requests.push(request);
    this.onDecide(request);
    const decision = await next(this.decisions, 'decide', request.signal);
    return agentStep(decision, 1_000 * this.requests.length);
  }
  planCompaction(trigger: CompactionTrigger): CompactionPlan | null {
    this.triggers.push(trigger);
    return this.plan(trigger);
  }
  measureConversation({ summary, messages }: ConversationView): number {
    return FAKE_MESSAGE_TOKENS * (messages.length + (summary === null ? 0 : 1));
  }
}

export const FAKE_MESSAGE_TOKENS = 1_000;

export const EMPTY_CONVERSATION: ConversationView = { summary: null, messages: [] };

export function coverAllButLastTurn(trigger: CompactionTrigger): CompactionPlan | null {
  const { messages } = trigger.kind === 'manual' ? trigger.conversation : trigger.step.conversation;
  const start = messages.findLastIndex(isRequestMessage);
  if (start <= 0) return null;
  return { covered: messages.slice(0, start) };
}

export class FakeSummarizer implements ConversationSummarizer {
  requests: SummaryRequest[] = [];
  private summaries: Step<string>[] = [];

  will(...summaries: Step<string>[]): this {
    this.summaries.push(...summaries);
    return this;
  }
  summarize(request: SummaryRequest): Promise<string> {
    this.requests.push(request);
    return next(this.summaries, 'summarize', request.signal);
  }
}

export class FakeProject implements ProjectPort {
  readonly files: readonly ProjectFile[];
  readonly opened: string[] = [];
  readonly reads: string[] = [];
  readonly signals: CancellationSignal[] = [];
  compileCalls = 0;
  holdsReads = false;
  failure: Partial<Record<'listFiles' | 'readFile' | 'openFile', Error>> = {};
  onOpen: (path: string) => void = () => undefined;
  private compiles: Step<readonly CompileDiagnostic[]>[] = [];
  private readonly readSteps = new Map<string, Error | PendingStep<DocumentSnapshot>>();
  private readonly readSignals = new Map<string, CancellationSignal>();
  private readonly savedDocuments: Map<string, readonly string[]>;
  private openPath: string;

  constructor(
    private readonly editor: FakeEditor,
    documents: Readonly<Record<string, readonly string[]>>,
    openPath: string,
    binaryPaths: readonly string[] = [],
  ) {
    this.savedDocuments = new Map(
      Object.entries(documents).map(([path, lines]) => [path, [...lines]]),
    );
    this.files = createProjectFiles([
      ...Object.keys(documents).map((path) => ({
        id: `doc:${path}`,
        path,
        kind: ProjectFileKind.Text,
      })),
      ...binaryPaths.map((path) => ({ id: `file:${path}`, path, kind: ProjectFileKind.Binary })),
    ]);
    this.openPath = openPath;
    this.show(openPath);
  }

  willCompile(...results: Step<readonly CompileDiagnostic[]>[]): this {
    this.compiles.push(...results);
    return this;
  }
  willRead(path: string, step: Error | PendingStep<DocumentSnapshot>): this {
    this.readSteps.set(path, step);
    return this;
  }
  readSignal(path: string): CancellationSignal {
    const signal = this.readSignals.get(path);
    if (signal === undefined) throw new TestFixtureError(`${path} was not read`);
    return signal;
  }
  switchTo(path: string): void {
    this.savedDocuments.set(this.openPath, [...this.editor.lines]);
    this.openPath = path;
    this.show(path);
  }
  savedDocument(path: string): readonly string[] {
    const lines = this.savedDocuments.get(path);
    if (lines === undefined) throw new TestFixtureError(`no document ${path}`);
    return lines;
  }
  listFiles(): readonly ProjectFile[] {
    if (this.failure.listFiles) throw this.failure.listFiles;
    return this.files;
  }
  shownFile(): TextFile {
    return findTextFile(this.files, this.openPath);
  }
  isShown(file: TextFile): boolean {
    return file.path === this.openPath;
  }
  readFile(file: TextFile, signal: CancellationSignal): Promise<DocumentSnapshot> {
    this.reads.push(file.path);
    this.signals.push(signal);
    this.readSignals.set(file.path, signal);
    const step = this.readSteps.get(file.path);
    if (step instanceof Error) return Promise.reject(step);
    if (step !== undefined) return step.settle(signal);
    if (this.failure.readFile) return Promise.reject(this.failure.readFile);
    if (this.holdsReads) return rejectOnAbort(signal);
    const lines = file.path === this.openPath ? this.editor.lines : this.savedDocument(file.path);
    return Promise.resolve(createDocumentSnapshot([...lines]));
  }
  openFile(file: TextFile, signal: CancellationSignal): Promise<void> {
    this.signals.push(signal);
    if (this.failure.openFile) return Promise.reject(this.failure.openFile);
    if (this.isShown(file)) return Promise.resolve();
    this.opened.push(file.path);
    this.switchTo(file.path);
    this.onOpen(file.path);
    return Promise.resolve();
  }
  compile(signal: CancellationSignal): Promise<readonly CompileDiagnostic[]> {
    this.compileCalls += 1;
    this.signals.push(signal);
    return next(this.compiles, 'compile', signal);
  }
  private show(path: string): void {
    this.editor.lines = [...this.savedDocument(path)];
    this.editor.shownFileId = findTextFile(this.files, path).id;
  }
}

function next<T>(queue: Step<T>[], what: string, signal: CancellationSignal): Promise<T> {
  const step = queue.shift();
  if (step === undefined) {
    return Promise.reject(new UnexpectedFakeCallError(`unexpected ${what} call`));
  }
  if (step instanceof Error) return Promise.reject(step);
  if (step instanceof PendingStep) return step.settle(signal);
  return Promise.resolve(step);
}

export class FakeWebSearch implements WebSearchPort {
  readonly queries: string[] = [];
  readonly signals: CancellationSignal[] = [];
  private results: Step<readonly WebSearchResult[]>[] = [];

  will(...results: Step<readonly WebSearchResult[]>[]): this {
    this.results.push(...results);
    return this;
  }
  search(query: string, signal: CancellationSignal): Promise<readonly WebSearchResult[]> {
    this.queries.push(query);
    this.signals.push(signal);
    return next(this.results, 'search', signal);
  }
}

export function webResult(index: number, snippetChars = 40): WebSearchResult {
  return {
    title: `Result ${String(index)}`,
    url: `https://example.org/${String(index)}`,
    snippet: 's'.repeat(snippetChars),
  };
}

export class InMemorySessionRepository implements SessionRepository {
  failing = false;
  unreadableIds: string[] = [];
  loadsHeldUntil: Promise<void> = Promise.resolve();
  readonly stored = new Map<string, ConversationSession>();

  constructor(...sessions: ConversationSession[]) {
    for (const session of sessions) this.stored.set(session.id, session);
  }
  list(): Promise<SessionListing> {
    if (this.failing) return Promise.reject(storageOff());
    const sessions = [...this.stored.values()].map(summarizeSession);
    return Promise.resolve({ sessions, unreadableIds: [...this.unreadableIds] });
  }
  async load(id: string): Promise<ConversationSession> {
    await this.loadsHeldUntil;
    return await this.find(id);
  }
  private find(id: string): Promise<ConversationSession> {
    if (this.failing) return Promise.reject(storageOff());
    if (this.unreadableIds.includes(id)) {
      return Promise.reject(new UnreadableSessionError('The saved session is corrupted.'));
    }
    const session = this.stored.get(id);
    if (session === undefined) return Promise.reject(new SessionNotFoundError(`no session ${id}`));
    return Promise.resolve(session);
  }
  save(session: ConversationSession): Promise<void> {
    if (this.failing) return Promise.reject(storageOff());
    this.stored.set(session.id, session);
    return Promise.resolve();
  }
  delete(id: string): Promise<void> {
    if (this.failing) return Promise.reject(storageOff());
    this.stored.delete(id);
    this.unreadableIds = this.unreadableIds.filter((unreadable) => unreadable !== id);
    return Promise.resolve();
  }
  only(): ConversationSession {
    const [session, ...others] = this.stored.values();
    if (session === undefined || others.length) {
      throw new TestFixtureError(`${String(this.stored.size)} sessions are stored, not one`);
    }
    return session;
  }
}

export class InMemorySessionArchive implements SessionArchive {
  failure: Error | null = null;
  readonly saved = new Map<string, SessionExport>();
  readonly signals: CancellationSignal[] = [];

  save(path: string, exported: SessionExport, signal: CancellationSignal): Promise<void> {
    this.signals.push(signal);
    if (this.failure) return Promise.reject(this.failure);
    this.saved.set(path, structuredClone(exported));
    return Promise.resolve();
  }
  load(file: ProjectFile, signal: CancellationSignal): Promise<SessionExport> {
    this.signals.push(signal);
    if (this.failure) return Promise.reject(this.failure);
    const exported = this.saved.get(file.path);
    if (exported === undefined) throw new TestFixtureError(`no export at ${file.path}`);
    return Promise.resolve(structuredClone(exported));
  }
}

function storageOff(): SessionStorageError {
  return new SessionStorageError('storage off');
}

export function storedSession(
  id: string,
  messages: readonly ConversationMessage[],
  updatedAt = 1,
): ConversationSession {
  return { id, title: `Session ${id}`, createdAt: 0, updatedAt, messages, imported: null };
}

export function sequentialIds(prefix = 'id'): () => string {
  let next = 0;
  return () => `${prefix}-${String((next += 1))}`;
}

export function ticking(): () => number {
  let now = 0;
  return () => (now += 1);
}

export function rejectOnAbort(signal: CancellationSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = (): void => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error ? reason : new TestFixtureError('the abort reason is no error'),
      );
    };
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort);
  });
}
