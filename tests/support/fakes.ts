import type { AssistantPlan } from '../../src/domain/assistant-plan';
import type { AssistantReply } from '../../src/domain/assistant-reply';
import type { ConversationMessage } from '../../src/domain/conversation';
import { createDocumentSnapshot, type DocumentSnapshot } from '../../src/domain/document';
import type { DocumentCommand } from '../../src/domain/document-command';
import type { ResolvedEdit } from '../../src/domain/resolved-edit';
import type { AssistantPort, PlanningRequest, ReplyRequest } from '../../src/ports/assistant-port';
import type { ConversationRepository } from '../../src/ports/conversation-repository';
import type { EditorPort } from '../../src/ports/editor-port';
import { EditorUnavailableError, PersistenceError } from '../../src/ports/errors';
import { UnexpectedFakeCallError } from './test-errors';

export class FakeEditor implements EditorPort {
  available = true;
  selection = '';
  cursorLine = 1;
  logs = '';
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
  readCompileLogs(): string {
    return this.logs;
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

export class FakeAssistant implements AssistantPort {
  planRequests: PlanningRequest[] = [];
  replyRequests: ReplyRequest[] = [];
  private plans: Step<AssistantPlan>[] = [];
  private replies: Step<AssistantReply>[] = [];

  willPlan(...plans: Step<AssistantPlan>[]): this {
    this.plans.push(...plans);
    return this;
  }
  willReply(...replies: Step<AssistantReply>[]): this {
    this.replies.push(...replies);
    return this;
  }
  plan(request: PlanningRequest): Promise<AssistantPlan> {
    this.planRequests.push(request);
    return next(this.plans, 'plan');
  }
  reply(request: ReplyRequest): Promise<AssistantReply> {
    this.replyRequests.push(request);
    return next(this.replies, 'reply');
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
