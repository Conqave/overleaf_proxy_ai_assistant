import type { AgentDecision } from '../../src/domain/agent-action';
import type { CompileDiagnostic } from '../../src/domain/agent-transcript';
import type { ConversationMessage } from '../../src/domain/conversation';
import { createDocumentSnapshot, type DocumentSnapshot } from '../../src/domain/document';
import type { DocumentCommand } from '../../src/domain/document-command';
import {
  createProjectFiles,
  ProjectFileKind,
  type ProjectFile,
} from '../../src/domain/project-file';
import type { ResolvedEdit } from '../../src/domain/resolved-edit';
import type { AgentPort, AgentStep, AgentStepRequest } from '../../src/ports/agent-port';
import type { ConversationRepository } from '../../src/ports/conversation-repository';
import type { EditorPort } from '../../src/ports/editor-port';
import type { ProjectPort } from '../../src/ports/project-port';
import { EditorUnavailableError, PersistenceError } from '../../src/ports/errors';
import { TestFixtureError, UnexpectedFakeCallError } from './test-errors';

export class FakeEditor implements EditorPort {
  available = true;
  selection = '';
  cursorLine = 1;
  preview: ResolvedEdit | null = null;
  applyFailure: Error | null = null;
  applied: DocumentCommand[] = [];

  constructor(public lines: string[]) {}

  readDocument(): DocumentSnapshot {
    this.ensureAvailable();
    return createDocumentSnapshot(this.lines);
  }
  readSelection(): string {
    return this.selection;
  }
  readCursorLine(): number {
    return this.cursorLine;
  }
  showPreview(edit: ResolvedEdit): void {
    this.ensureAvailable();
    this.preview = edit;
  }
  clearPreview(): void {
    this.preview = null;
  }
  apply({ command }: ResolvedEdit): void {
    this.ensureAvailable();
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
  private ensureAvailable(): void {
    if (!this.available) throw new EditorUnavailableError('no editor');
  }
}

type Step<T> = T | Error;

export function agentStep(decision: AgentDecision): AgentStep {
  return {
    decision,
    contextUsage: { contextTokens: 98304, estimatedPromptTokens: 1200, promptTokens: 1150 },
  };
}

export class FakeAgent implements AgentPort {
  requests: AgentStepRequest[] = [];
  private decisions: Step<AgentDecision>[] = [];

  will(...decisions: Step<AgentDecision>[]): this {
    this.decisions.push(...decisions);
    return this;
  }
  async decide(request: AgentStepRequest): Promise<AgentStep> {
    this.requests.push(request);
    return agentStep(await next(this.decisions, 'decide'));
  }
}

export class FakeProject implements ProjectPort {
  readonly files: readonly ProjectFile[];
  readonly opened: string[] = [];
  readonly reads: string[] = [];
  compileCalls = 0;
  failure: Partial<Record<'listFiles' | 'readFile' | 'openFile', Error>> = {};
  onOpen: (path: string) => void = () => undefined;
  private compiles: Step<readonly CompileDiagnostic[]>[] = [];

  constructor(
    private readonly editor: FakeEditor,
    private readonly documents: Record<string, string[]>,
    private openPath: string,
    binaryPaths: readonly string[] = [],
  ) {
    this.files = createProjectFiles([
      ...Object.keys(documents).map((path) => ({
        id: `doc:${path}`,
        path,
        kind: ProjectFileKind.Text,
      })),
      ...binaryPaths.map((path) => ({ id: `file:${path}`, path, kind: ProjectFileKind.Binary })),
    ]);
    editor.lines = this.document(openPath);
  }

  willCompile(...results: Step<readonly CompileDiagnostic[]>[]): this {
    this.compiles.push(...results);
    return this;
  }
  switchTo(path: string): void {
    this.openPath = path;
    this.editor.lines = this.document(path);
  }
  listFiles(): readonly ProjectFile[] {
    if (this.failure.listFiles) throw this.failure.listFiles;
    return this.files;
  }
  openFilePath(): string {
    return this.openPath;
  }
  readFile(file: ProjectFile): Promise<DocumentSnapshot> {
    this.reads.push(file.path);
    if (this.failure.readFile) return Promise.reject(this.failure.readFile);
    const lines = file.path === this.openPath ? this.editor.lines : this.document(file.path);
    return Promise.resolve(createDocumentSnapshot(lines));
  }
  openFile(file: ProjectFile): Promise<void> {
    this.opened.push(file.path);
    if (this.failure.openFile) return Promise.reject(this.failure.openFile);
    this.switchTo(file.path);
    this.onOpen(file.path);
    return Promise.resolve();
  }
  compile(): Promise<readonly CompileDiagnostic[]> {
    this.compileCalls += 1;
    return next(this.compiles, 'compile');
  }
  private document(path: string): string[] {
    const lines = this.documents[path];
    if (lines === undefined) throw new TestFixtureError(`no document ${path}`);
    return lines;
  }
}

function next<T>(queue: Step<T>[], what: string): Promise<T> {
  const step = queue.shift();
  if (step === undefined)
    return Promise.reject(new UnexpectedFakeCallError(`unexpected ${what} call`));
  return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
}

export class InMemoryConversationRepository implements ConversationRepository {
  failing = false;
  constructor(public stored: ConversationMessage[] = []) {}
  load(): ConversationMessage[] {
    if (this.failing) throw new PersistenceError('storage off');
    return [...this.stored];
  }
  save(messages: readonly ConversationMessage[]): void {
    if (this.failing) throw new PersistenceError('storage off');
    this.stored = [...messages];
  }
  clear(): void {
    if (this.failing) throw new PersistenceError('storage off');
    this.stored = [];
  }
}

export function sequentialIds(): () => string {
  let next = 0;
  return () => `id-${String((next += 1))}`;
}
