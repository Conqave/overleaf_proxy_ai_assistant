import type { AgentProgress } from '../../src/application/agent-progress';
import { ApplyChangeSet } from '../../src/application/apply-change-set';
import { ConversationCompactor } from '../../src/application/conversation-compactor';
import { ConversationLog } from '../../src/application/conversation-log';
import {
  DeleteSession,
  ListSessions,
  OpenSession,
  RestoreLatestSession,
  StartNewConversation,
} from '../../src/application/conversation-session';
import type { AgentResult, ConversationAgent } from '../../src/application/conversation-agent';
import type { HandleAssistantRequest } from '../../src/application/handle-assistant-request';
import { OperationLock } from '../../src/application/operation-lock';
import { PendingChanges } from '../../src/application/pending-change';
import { PreviewChangeSetFile } from '../../src/application/preview-change-set-file';
import { RejectChangeSet } from '../../src/application/reject-change-set';
import { ReviewAppliedChange } from '../../src/application/review-applied-change';
import { UndoChangeSet } from '../../src/application/undo-change-set';
import type { WebSearchTool } from '../../src/application/web-search-tool';
import type { AgentDecision } from '../../src/domain/agent-action';
import type { EditRequest } from '../../src/domain/change-set';
import { createDocumentCommand } from '../../src/domain/document-command';
import { InvariantViolation } from '../../src/domain/errors';
import type { ConversationSession } from '../../src/domain/session';
import { tool } from './decisions';
import {
  FakeAgent,
  FakeEditor,
  FakeProject,
  FakeSummarizer,
  InMemorySessionRepository,
  sequentialIds,
  ticking,
} from './fakes';
import { itemAt } from './guards';
import { composeRequestHandling } from './request-handling';

export const MAIN = [
  '\\section{Intro}',
  'Hello world.',
  '\\section{Results}',
  'Numbers \\cite{knuth84}.',
];
export const BIB = ['@article{smith20,', '  title = {Smith},', '}'];
export const NOW = new Date('2026-10-01T12:00:00Z');

export function editOf(path: string, lines: readonly string[], lineNumber: number): AgentDecision {
  return editsOf(insertionOf(path, lines, lineNumber));
}

export function insertionOf(
  path: string,
  lines: readonly string[],
  lineNumber: number,
): EditRequest {
  return insertionAt(path, lineNumber, itemAt(lines, lineNumber - 1, 'line'));
}

export function editAt(path: string, lineNumber: number, lineText: string): AgentDecision {
  return editsOf(insertionAt(path, lineNumber, lineText));
}

export function insertionAt(path: string, lineNumber: number, lineText: string): EditRequest {
  return {
    path,
    command: createDocumentCommand({
      operation: 'insert_after',
      target: { lineNumber, lineText },
      content: 'Added.',
      reason: 'Adds detail.',
    }),
  };
}

export function editsOf(...edits: EditRequest[]): AgentDecision {
  return { kind: 'reply', reply: { kind: 'edit', edits } };
}

export const mainEdit = () => editOf('main.tex', MAIN, 4);
export const bibEdit = () => editOf('refs.bib', BIB, 3);
export const readBib = () => tool({ tool: 'read_file', path: 'refs.bib' });

export function changeIdOf(result: AgentResult): string {
  if (result.kind !== 'proposal') throw new InvariantViolation('no change proposed');
  return result.message.id;
}

export class UseCaseWorld {
  editor = new FakeEditor([]);
  project = new FakeProject(
    this.editor,
    { 'main.tex': MAIN, 'refs.bib': BIB, 'chapters/intro.tex': ['Intro about knuth.'] },
    'main.tex',
    ['figures/plot.png'],
  );
  readonly agent = new FakeAgent();
  readonly repository = new InMemorySessionRepository();
  readonly conversation = new ConversationLog({
    sessions: this.repository,
    newId: sequentialIds('session'),
    now: ticking(),
  });
  readonly pendingChanges = new PendingChanges({
    conversation: this.conversation,
    editor: this.editor,
  });
  readonly lock = new OperationLock(() => new AbortController());
  readonly busy: boolean[] = [];
  readonly newId = sequentialIds();
  readonly summarizer = new FakeSummarizer();
  progress: AgentProgress[] = [];
  readonly resets: Promise<void>[] = [];
  handle: HandleAssistantRequest;
  conversationAgent: ConversationAgent;
  readonly review: ReviewAppliedChange;
  readonly apply: ApplyChangeSet;
  readonly reject: RejectChangeSet;
  readonly preview: PreviewChangeSetFile;
  readonly undo: UndoChangeSet;

  constructor() {
    this.lock.onChange((isNowBusy) => {
      this.busy.push(isNowBusy);
    });
    ({ handleRequest: this.handle, conversationAgent: this.conversationAgent } =
      this.composeRequests(null));
    const { project, conversation, editor, pendingChanges, lock, newId } = this;
    this.review = new ReviewAppliedChange({
      project,
      conversation,
      conversationAgent: this.conversationAgent,
    });
    const changeSetDeps = { project, conversation, editor, pendingChanges, review: this.review };
    this.apply = new ApplyChangeSet({ ...changeSetDeps, lock });
    this.reject = new RejectChangeSet({ ...changeSetDeps, lock });
    this.preview = new PreviewChangeSetFile({
      project,
      conversation,
      editor,
      pendingChanges,
      lock,
    });
    this.undo = new UndoChangeSet({ project, editor, conversation, lock, newId });
  }

  readonly isBusy = () => this.busy.at(-1) === true;
  readonly record = (p: AgentProgress) => {
    this.progress.push(p);
  };
  readonly send = (text: string) => this.handle.execute(text, this.record);
  readonly storedMessages = () => this.repository.only().messages;
  readonly seed = (session: ConversationSession) => {
    this.repository.stored.set(session.id, session);
  };
  readonly sessionDeps = () => ({
    sessions: this.repository,
    conversation: this.conversation,
    pendingChanges: this.pendingChanges,
    lock: this.lock,
  });
  readonly restore = () => new RestoreLatestSession(this.sessionDeps()).execute();
  readonly startNew = () => new StartNewConversation(this.sessionDeps()).execute();
  readonly resetLater = () => {
    this.resets.push(this.startNew());
  };
  readonly listSessions = () => new ListSessions(this.sessionDeps()).execute();
  readonly openSession = (id: string) => new OpenSession(this.sessionDeps()).execute(id);
  readonly deleteSession = (id: string) => new DeleteSession(this.sessionDeps()).execute(id);
  readonly requestAt = (index: number) => itemAt(this.agent.requests, index, 'agent request');

  async proposeEdit(...decisions: AgentDecision[]): Promise<string> {
    this.agent.will(...(decisions.length ? decisions : [mainEdit()]));
    return changeIdOf(await this.send('add more'));
  }

  wireRequests(webSearch: WebSearchTool | null = null): void {
    ({ handleRequest: this.handle, conversationAgent: this.conversationAgent } =
      this.composeRequests(webSearch));
  }

  private composeRequests(webSearch: WebSearchTool | null) {
    const { agent, project, editor, conversation, pendingChanges, lock, newId, summarizer } = this;
    return composeRequestHandling({
      agent,
      project,
      editor,
      conversation,
      pendingChanges,
      lock,
      newId,
      webSearch,
      compactor: new ConversationCompactor({
        agent,
        summarizer,
        conversation,
        newId,
        now: () => NOW,
      }),
    });
  }
}
