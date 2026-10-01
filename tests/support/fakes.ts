import type { AgentDecision } from '../../src/domain/agent-action';
import type { CompileDiagnostic } from '../../src/domain/agent-transcript';
import type { ConversationMessage } from '../../src/domain/conversation';
import { createDocumentSnapshot, type DocumentSnapshot } from '../../src/domain/document';
import type { DocumentCommand } from '../../src/domain/document-command';
import {
  createProjectFiles,
  findTextFile,
  ProjectFileKind,
  type ProjectFile,
  type TextFile,
} from '../../src/domain/project-file';
import type { ResolvedEdit } from '../../src/domain/resolved-edit';
import { summarizeSession, type ConversationSession } from '../../src/domain/session';
import type { AgentPort, AgentStep, AgentStepRequest } from '../../src/ports/agent-port';
import type { CancellationSignal } from '../../src/ports/cancellation';
import type { SessionListing, SessionRepository } from '../../src/ports/session-repository';
import type { EditorPort } from '../../src/ports/editor-port';
import type { ProjectPort } from '../../src/ports/project-port';
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
  preview: ResolvedEdit | null = null;
  applyFailure: Error | null = null;
  previewFailure: Error | null = null;
  applied: DocumentCommand[] = [];
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
  showPreview(file: TextFile, edit: ResolvedEdit): void {
    this.ensureShowing(file);
    if (this.previewFailure) throw this.previewFailure;
    this.preview = edit;
  }
  clearPreview(): void {
    this.preview = null;
  }
  apply(file: TextFile, { command }: ResolvedEdit): void {
    this.ensureShowing(file);
    if (this.applyFailure) throw this.applyFailure;
    const index = command.target.lineNumber - 1;
    const content = 'content' in command ? command.content.split('\n') : [];
    switch (command.operation) {
      case 'insert_before':
        this.lines.splice(index, 0, ...content);
        break;
      case 'insert_after':
        this.lines.splice(index + 1, 0, ...content);
        break;
      case 'replace':
        this.lines.splice(index, command.lineCount, ...content);
        break;
      case 'delete':
        this.lines.splice(index, command.lineCount);
        break;
    }
    this.applied.push(command);
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
    },
  };
}

export class FakeAgent implements AgentPort {
  readonly contextTokens = FAKE_CONTEXT_TOKENS;
  requests: AgentStepRequest[] = [];
  onDecide: (request: AgentStepRequest) => void = () => undefined;
  private decisions: Step<AgentDecision>[] = [];

  will(...decisions: Step<AgentDecision>[]): this {
    this.decisions.push(...decisions);
    return this;
  }
  async decide(request: AgentStepRequest): Promise<AgentStep> {
    this.requests.push(request);
    this.onDecide(request);
    const decision = await next(this.decisions, 'decide', request.signal);
    return agentStep(decision, 1_000 * this.requests.length);
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

function storageOff(): SessionStorageError {
  return new SessionStorageError('storage off');
}

export function storedSession(
  id: string,
  messages: readonly ConversationMessage[],
  updatedAt = 1,
): ConversationSession {
  return { id, title: `Session ${id}`, createdAt: 0, updatedAt, messages };
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
