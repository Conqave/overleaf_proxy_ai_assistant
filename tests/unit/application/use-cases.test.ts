import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProgress } from '../../../src/application/agent-progress';
import { ApplyDocumentChange } from '../../../src/application/apply-document-change';
import { ConversationLog } from '../../../src/application/conversation-log';
import {
  DeleteSession,
  ListSessions,
  OpenSession,
  RestoreLatestSession,
  StartNewConversation,
} from '../../../src/application/conversation-session';
import {
  AgentMistakeLimitError,
  ChangeNoLongerPendingError,
  EmptyRequestError,
  RequestInProgressError,
  RequestSupersededError,
} from '../../../src/application/errors';
import {
  COMPILE_FIX_REQUEST,
  HandleAssistantRequest,
  type AgentResult,
} from '../../../src/application/handle-assistant-request';
import { OperationLock } from '../../../src/application/operation-lock';
import { PARALLEL_SEARCH_READS } from '../../../src/application/project-tools';
import { PendingChanges } from '../../../src/application/pending-change';
import { RejectDocumentChange } from '../../../src/application/reject-document-change';
import { ReviewAppliedChange } from '../../../src/application/review-applied-change';
import type { AgentDecision, ToolCall } from '../../../src/domain/agent-action';
import type { CompileDiagnostic } from '../../../src/domain/agent-transcript';
import { AGENT_POLICY } from '../../../src/domain/agent-policy';
import { createDocumentSnapshot, type DocumentSnapshot } from '../../../src/domain/document';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { DocumentConflictError, InvariantViolation } from '../../../src/domain/errors';
import type { ConversationSession } from '../../../src/domain/session';
import {
  AssistantProtocolError,
  AssistantUnreachableError,
  CompileTimeoutError,
  EditorShowsOtherFileError,
  EditorUnavailableError,
  FileOpenTimeoutError,
  ProjectFileReadError,
  ProjectUnavailableError,
  SessionNotFoundError,
  SessionStorageError,
  UnreadableSessionError,
} from '../../../src/ports/errors';
import {
  FAKE_CONTEXT_TOKENS,
  FakeAgent,
  FakeEditor,
  FakeProject,
  InMemorySessionRepository,
  PendingStep,
  rejectOnAbort,
  sequentialIds,
  storedSession,
  ticking,
} from '../../support/fakes';
import { anInstanceOf, itemAt, textContaining } from '../../support/guards';
import { TestFixtureError } from '../../support/test-errors';

const MAIN = ['\\section{Intro}', 'Hello world.', '\\section{Results}', 'Numbers \\cite{knuth84}.'];
const BIB = ['@article{smith20,', '  title = {Smith},', '}'];

let editor: FakeEditor;
let project: FakeProject;
let agent: FakeAgent;
let repository: InMemorySessionRepository;
let conversation: ConversationLog;
let pendingChanges: PendingChanges;
let handle: HandleAssistantRequest;
let apply: ApplyDocumentChange;
let reject: RejectDocumentChange;
let review: ReviewAppliedChange;
let lock: OperationLock;
let progress: AgentProgress[];
let busy: boolean[];

const isBusy = () => busy.at(-1) === true;
const record = (p: AgentProgress) => {
  progress.push(p);
};
const send = (text: string) => handle.execute(text, record);
const storedMessages = () => repository.only().messages;
const seed = (session: ConversationSession) => {
  repository.stored.set(session.id, session);
};
const sessionDeps = () => ({ sessions: repository, conversation, pendingChanges, editor, lock });
const restore = () => new RestoreLatestSession(sessionDeps()).execute();
const startNew = () => {
  new StartNewConversation(sessionDeps()).execute();
};
const listSessions = () => new ListSessions(sessionDeps()).execute();
const openSession = (id: string) => new OpenSession(sessionDeps()).execute(id);
const deleteSession = (id: string) => new DeleteSession(sessionDeps()).execute(id);
const requestAt = (index: number) => itemAt(agent.requests, index, 'agent request');
const tool = (call: ToolCall): AgentDecision => ({ kind: 'tool', call });
const answer = (text: string): AgentDecision => ({
  kind: 'reply',
  reply: { kind: 'answer', text },
});

function editOf(path: string, lines: readonly string[], lineNumber: number): AgentDecision {
  return editAt(path, lineNumber, itemAt(lines, lineNumber - 1, 'line'));
}

function editAt(path: string, lineNumber: number, lineText: string): AgentDecision {
  return {
    kind: 'reply',
    reply: {
      kind: 'edit',
      path,
      command: createDocumentCommand({
        operation: 'insert_after',
        target: { lineNumber, lineText },
        content: 'Added.',
        reason: 'Adds detail.',
      }),
    },
  };
}

const mainEdit = () => editOf('main.tex', MAIN, 4);
const bibEdit = () => editOf('refs.bib', BIB, 3);
const readBib = () => tool({ tool: 'read_file', path: 'refs.bib' });

function changeIdOf(result: AgentResult): string {
  if (result.kind !== 'proposal') throw new InvariantViolation('no change proposed');
  return result.changeId;
}

async function proposeEdit(...decisions: AgentDecision[]): Promise<string> {
  agent.will(...(decisions.length ? decisions : [mainEdit()]));
  return changeIdOf(await send('add more'));
}

beforeEach(() => {
  editor = new FakeEditor([]);
  project = new FakeProject(
    editor,
    { 'main.tex': MAIN, 'refs.bib': BIB, 'chapters/intro.tex': ['Intro about knuth.'] },
    'main.tex',
    ['figures/plot.png'],
  );
  agent = new FakeAgent();
  repository = new InMemorySessionRepository();
  conversation = new ConversationLog({
    sessions: repository,
    newId: sequentialIds('session'),
    now: ticking(),
  });
  pendingChanges = new PendingChanges(conversation);
  lock = new OperationLock(() => new AbortController());
  busy = [];
  lock.onChange((isNowBusy) => {
    busy.push(isNowBusy);
  });
  const newId = sequentialIds();
  handle = new HandleAssistantRequest({
    agent,
    project,
    editor,
    conversation,
    pendingChanges,
    lock,
    newId,
    createController: () => new AbortController(),
  });
  review = new ReviewAppliedChange({ project, conversation, handleRequest: handle });
  apply = new ApplyDocumentChange({ editor, project, pendingChanges, conversation, lock, review });
  reject = new RejectDocumentChange({ editor, pendingChanges, lock });
  progress = [];
});

describe('HandleAssistantRequest', () => {
  it('rejects an empty request', async () => {
    await expect(send('   ')).rejects.toThrow(EmptyRequestError);
    expect(conversation.messages()).toHaveLength(0);
  });

  it('sends a greeting to the agent like any other message', async () => {
    agent.will(answer('Hi! What should I change?'));
    const result = await send('Cześć!');
    expect(result.message).toMatchObject({ kind: 'explanation' });
    expect(requestAt(0).request).toMatchObject({ message: { role: 'user', text: 'Cześć!' } });
    expect(storedMessages().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('answers without tools and shows the agent the whole workspace', async () => {
    editor.cursorLine = 2;
    editor.selection = 'world';
    agent.will(answer('A short paper.'));
    const result = await send('What is this document about?');
    expect(result.kind).toBe('reply');
    expect(result.message).toMatchObject({ kind: 'explanation', text: 'A short paper.' });
    expect(agent.requests[0]).toEqual({
      request: {
        kind: 'user',
        message: { id: anInstanceOf(String), role: 'user', text: 'What is this document about?' },
      },
      conversation: [],
      workspace: {
        files: project.files,
        openFile: { path: 'main.tex', document: createDocumentSnapshot(MAIN) },
        cursorLine: 2,
        selection: 'world',
      },
      transcript: [],
      signal: anInstanceOf(AbortSignal),
    });
    expect(progress.map((p) => p.stage)).toEqual(['received', 'thinking']);
  });

  it('reports the context usage of the decision that ended the request', async () => {
    agent.will(tool({ tool: 'compile' }), answer('It compiles.'));
    project.willCompile([]);
    const result = await send('does it compile?');
    expect(result).toHaveProperty('contextUsage', {
      contextTokens: FAKE_CONTEXT_TOKENS,
      promptTokens: 2_000,
    });
  });

  it('passes the conversation to the agent', async () => {
    agent.will(answer('ok'), answer('fine'));
    await send('hello');
    await send('second?');
    expect(requestAt(1).conversation).toMatchObject([
      { role: 'user', text: 'hello' },
      { role: 'assistant', kind: 'explanation', text: 'ok' },
    ]);
  });

  it('turns a question into a clarification', async () => {
    agent.will({ kind: 'reply', reply: { kind: 'question', text: 'Which table?' } });
    const result = await send('fix the table');
    expect(result.message).toMatchObject({ kind: 'clarification', text: 'Which table?' });
  });

  it('proposes an edit of the open file as a previewed pending change', async () => {
    agent.will(mainEdit());
    const result = await send('add more');
    expect(result.message).toEqual({
      id: changeIdOf(result),
      role: 'assistant',
      kind: 'proposal',
      path: 'main.tex',
      command: editor.preview?.command,
      status: 'proposed',
    });
    expect(pendingChanges.isPending(changeIdOf(result))).toBe(true);
    expect(project.opened).toEqual([]);
    expect(editor.applied).toHaveLength(0);
  });

  it('reads another file, then opens it before previewing its edit', async () => {
    agent.will(tool({ tool: 'read_file', path: 'refs.bib' }), bibEdit());
    const result = await send('add knuth84 to the bibliography');
    expect(requestAt(1).transcript).toEqual([
      {
        kind: 'tool',
        call: { tool: 'read_file', path: 'refs.bib' },
        result: { tool: 'read_file', path: 'refs.bib', document: createDocumentSnapshot(BIB) },
      },
    ]);
    expect(project.opened).toEqual(['refs.bib']);
    expect(result.message).toMatchObject({ kind: 'proposal', path: 'refs.bib' });
    expect(result.message).toHaveProperty('command', editor.preview?.command);
    expect(progress).toEqual([
      expect.objectContaining({ stage: 'received' }),
      { stage: 'thinking', step: 1 },
      { stage: 'reading', path: 'refs.bib' },
      { stage: 'thinking', step: 2 },
      { stage: 'opening', path: 'refs.bib' },
    ]);
  });

  it('searches every text file of the project', async () => {
    agent.will(tool({ tool: 'search', query: 'KNUTH' }), answer('Cited in main.tex.'));
    await send('where is knuth cited?');
    expect(project.reads.sort()).toEqual(['chapters/intro.tex', 'main.tex', 'refs.bib']);
    expect(requestAt(1).transcript[0]).toMatchObject({ kind: 'tool' });
    expect(requestAt(1).transcript[0]).toHaveProperty('result', {
      tool: 'search',
      matches: [
        { path: 'main.tex', lineNumber: 4, lineText: 'Numbers \\cite{knuth84}.' },
        { path: 'chapters/intro.tex', lineNumber: 1, lineText: 'Intro about knuth.' },
      ],
      truncated: false,
    });
    expect(progress).toContainEqual({ stage: 'searching', query: 'KNUTH' });
  });

  it('cancels the other reads of a search when one fails and waits for them', async () => {
    const mainRead = Promise.withResolvers<DocumentSnapshot>();
    project.willRead('main.tex', new PendingStep(() => mainRead.promise));
    project.willRead('chapters/intro.tex', new PendingStep(rejectOnAbort));
    project.willRead('refs.bib', new ProjectFileReadError('404'));
    agent.will(tool({ tool: 'search', query: 'knuth' }));
    let settled = false;
    const sending = send('where is knuth cited?').finally(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(project.readSignal('main.tex').aborted).toBe(true);
    });
    expect(project.readSignal('chapters/intro.tex').aborted).toBe(true);
    expect(settled).toBe(false);
    mainRead.resolve(createDocumentSnapshot(MAIN));
    await expect(sending).rejects.toThrow(ProjectFileReadError);
    expect(agent.requests).toHaveLength(1);
  });

  it('reads at most a few files of a search at a time', async () => {
    const documents = Object.fromEntries(
      Array.from({ length: PARALLEL_SEARCH_READS + 2 }, (_, index) => [
        `part${String(index)}.tex`,
        ['text'],
      ]),
    );
    project = new FakeProject(editor, documents, 'part0.tex');
    handle = new HandleAssistantRequest({
      agent,
      project,
      editor,
      conversation,
      pendingChanges,
      lock,
      newId: sequentialIds(),
      createController: () => new AbortController(),
    });
    project.holdsReads = true;
    agent.will(tool({ tool: 'search', query: 'text' }));
    const sending = send('find text');
    await vi.waitFor(() => {
      expect(project.reads).toHaveLength(PARALLEL_SEARCH_READS);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(project.reads).toHaveLength(PARALLEL_SEARCH_READS);
    startNew();
    await expect(sending).rejects.toThrow(RequestSupersededError);
  });

  it('compiles the project and hands the diagnostics to the agent', async () => {
    const diagnostics = [{ level: 'error' as const, message: 'Undefined control sequence.' }];
    project.willCompile(diagnostics);
    agent.will(tool({ tool: 'compile' }), answer('A typo on line 2.'));
    await send('why does it not compile?');
    expect(requestAt(1).transcript[0]).toEqual({
      kind: 'tool',
      call: { tool: 'compile' },
      result: { tool: 'compile', diagnostics },
    });
    expect(progress).toContainEqual({ stage: 'compiling' });
  });

  it('sends a repeated tool call back to the agent as a rejected step', async () => {
    const call = tool({ tool: 'read_file', path: 'refs.bib' });
    agent.will(call, call, answer('One entry.'));
    const result = await send('read it twice');
    expect(result.message).toMatchObject({ kind: 'explanation', text: 'One entry.' });
    expect(project.reads).toEqual(['refs.bib']);
    expect(requestAt(2).transcript[1]).toEqual({
      kind: 'mistake',
      decision: call,
      problem: 'read_file was already called with the same argument; use its earlier result',
    });
  });

  it('sends a tool call beyond the budget back to the agent', async () => {
    const queries = Array.from({ length: AGENT_POLICY.maxToolCalls + 1 }, (_, index) =>
      tool({ tool: 'search', query: `query ${String(index)}` }),
    );
    agent.will(...queries, answer('Nothing found.'));
    await expect(send('search forever')).resolves.toMatchObject({
      message: { kind: 'explanation' },
    });
    expect(requestAt(-1).transcript.at(-1)).toMatchObject({
      kind: 'mistake',
      problem: textContaining('lookups are used'),
    });
  });

  it.each([
    [
      'a read of a file missing from the project',
      tool({ tool: 'read_file', path: 'gone.tex' }),
      'The project has no file gone.tex.',
    ],
    [
      'a read of a binary file',
      tool({ tool: 'read_file', path: 'figures/plot.png' }),
      'figures/plot.png is not a text file.',
    ],
    ['an edit of a file missing from the project', editOf('gone.tex', MAIN, 4), 'no file gone.tex'],
    ['an edit of a file it has not read', bibEdit(), 'refs.bib must be read with read_file'],
    [
      'an edit whose line does not match its quote',
      editAt('main.tex', 2, '\\section{Results}'),
      'The quoted text starts line 3, not line 2',
    ],
    [
      'an edit range past the end of the file',
      {
        kind: 'reply',
        reply: {
          kind: 'edit',
          path: 'main.tex',
          command: createDocumentCommand({
            operation: 'delete',
            target: { lineNumber: 4, lineText: itemAt(MAIN, 3, 'line') },
            lineCount: 3,
          }),
        },
      } satisfies AgentDecision,
      'run past the end of the document',
    ],
  ])('sends %s back to the agent to correct', async (_name, mistake, problem) => {
    agent.will(mistake, answer('Corrected.'));
    await expect(send('do it')).resolves.toMatchObject({ message: { text: 'Corrected.' } });
    expect(requestAt(1).transcript).toEqual([
      { kind: 'mistake', decision: mistake, problem: textContaining(problem) },
    ]);
    expect(editor.preview).toBeNull();
    expect(project.reads).toEqual([]);
  });

  it('gives up after too many consecutive mistakes', async () => {
    const mistakes = Array.from({ length: AGENT_POLICY.maxConsecutiveMistakes }, () =>
      editOf('gone.tex', MAIN, 4),
    );
    agent.will(...mistakes);
    await expect(send('add more')).rejects.toThrow(AgentMistakeLimitError);
    expect(agent.requests).toHaveLength(AGENT_POLICY.maxConsecutiveMistakes);
    expect(pendingChanges.discardAll()).toEqual([]);
    expect(editor.preview).toBeNull();
  });

  it('starts counting mistakes again after a successful tool call', async () => {
    const mistake = editOf('gone.tex', MAIN, 4);
    const almost = AGENT_POLICY.maxConsecutiveMistakes - 1;
    agent.will(
      ...Array.from({ length: almost }, () => mistake),
      tool({ tool: 'compile' }),
      ...Array.from({ length: almost }, () => mistake),
      answer('Done.'),
    );
    project.willCompile([]);
    await expect(send('add more')).resolves.toMatchObject({ message: { text: 'Done.' } });
  });

  it('reopens the target file when the user switched files during the request', async () => {
    agent.onDecide = () => {
      project.switchTo('refs.bib');
    };
    agent.will(mainEdit());
    const result = await send('add more');
    expect(project.opened).toEqual(['main.tex']);
    expect(result.message).toHaveProperty('command', editor.preview?.command);
  });

  it('drops an edit whose file changed before it was opened', async () => {
    project.onOpen = () => {
      editor.lines[0] = '@book{knuth84,';
    };
    agent.will(tool({ tool: 'read_file', path: 'refs.bib' }), bibEdit());
    await expect(send('add knuth84')).rejects.toThrow(DocumentConflictError);
    expect(editor.preview).toBeNull();
    expect(conversation.messages().map((m) => m.role)).toEqual(['user']);
  });

  it('drops an edit when the document changed while the agent was working', async () => {
    agent.onDecide = () => {
      editor.lines[0] = '\\section{Introduction}';
    };
    agent.will(mainEdit());
    await expect(send('add more')).rejects.toThrow(DocumentConflictError);
    expect(editor.preview).toBeNull();
    expect(conversation.messages().map((m) => m.role)).toEqual(['user']);
  });

  it('drops an edit whose preview fails', async () => {
    agent.will(mainEdit());
    editor.previewFailure = new EditorUnavailableError('gone');
    await expect(send('add more')).rejects.toThrow(EditorUnavailableError);
    expect(conversation.messages().map((m) => m.role)).toEqual(['user']);
  });

  it('propagates agent failures', async () => {
    agent.will(new AssistantUnreachableError('down'));
    await expect(send('summarize')).rejects.toThrow(AssistantUnreachableError);
    agent.will(new AssistantProtocolError('bad'));
    await expect(send('summarize')).rejects.toThrow(AssistantProtocolError);
  });

  it.each([
    ['reading a file', 'readFile' as const, new ProjectFileReadError('404')],
    ['opening a file', 'openFile' as const, new FileOpenTimeoutError('slow')],
  ])('propagates a project failure while %s', async (_name, method, error) => {
    project.failure[method] = error;
    agent.will(tool({ tool: 'read_file', path: 'refs.bib' }), bibEdit());
    await expect(send('add knuth84')).rejects.toThrow(error);
    expect(editor.preview).toBeNull();
  });

  it('propagates a compile timeout', async () => {
    project.willCompile(new CompileTimeoutError('no log'));
    agent.will(tool({ tool: 'compile' }));
    await expect(send('does it compile?')).rejects.toThrow(CompileTimeoutError);
  });

  it('requires the project and the editor before asking the agent', async () => {
    project.failure.listFiles = new ProjectUnavailableError('no tree');
    await expect(send('summarize')).rejects.toThrow(ProjectUnavailableError);
    project.failure = {};
    editor.available = false;
    await expect(send('summarize')).rejects.toThrow(EditorUnavailableError);
    expect(agent.requests).toHaveLength(0);
    expect(conversation.messages().map((m) => m.role)).toEqual(['user', 'user']);
  });

  it('waits for the editor to show the open file and never mixes up two files', async () => {
    editor.shownFileId = 'doc:refs.bib';
    await expect(send('summarize')).rejects.toThrow(EditorShowsOtherFileError);
    expect(agent.requests).toHaveLength(0);
    expect(project.signals).toHaveLength(1);
  });

  it('accepts one request at a time', async () => {
    agent.will(answer('A short paper.'));
    const first = send('What is this document about?');
    await expect(send('And the second one?')).rejects.toThrow(RequestInProgressError);
    await expect(first).resolves.toMatchObject({ message: { kind: 'explanation' } });
  });

  it('discards the open change when a new request starts and records it', async () => {
    const changeId = await proposeEdit();
    progress = [];
    agent.will(answer('Hi.'));
    await send('hi');
    expect(editor.preview).toBeNull();
    const discarded = { id: changeId, kind: 'proposal', status: 'discarded' };
    expect(progress[0]).toMatchObject({ stage: 'decided', message: discarded });
    expect(storedMessages()).toContainEqual(expect.objectContaining(discarded));
    expect(requestAt(-1).conversation).toContainEqual(expect.objectContaining(discarded));
    await expect(apply.execute(changeId, record)).rejects.toThrow(ChangeNoLongerPendingError);
    await expect(reject.execute(changeId)).rejects.toThrow(ChangeNoLongerPendingError);
  });
});

describe('conversation reset during a request', () => {
  it('cancels the running request and frees the assistant at once', async () => {
    agent.will(new PendingStep(rejectOnAbort));
    const running = send('summarize');
    await vi.waitFor(() => {
      expect(agent.requests).toHaveLength(1);
    });
    startNew();
    await expect(running).rejects.toThrow(RequestSupersededError);
    expect(isBusy()).toBe(false);
    agent.will(answer('Fresh.'));
    await expect(send('summarize again')).resolves.toMatchObject({ message: { text: 'Fresh.' } });
  });

  it('drops the late reply instead of adding it to the new conversation', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    agent.will(
      new PendingStep(async () => {
        await gate;
        return mainEdit();
      }),
    );
    const running = send('add');
    startNew();
    release();
    await expect(running).rejects.toThrow(RequestSupersededError);
    expect(conversation.messages()).toHaveLength(0);
    expect(editor.preview).toBeNull();
  });

  it('drops the request when the conversation is reset during a tool call', async () => {
    agent.will(tool({ tool: 'compile' }));
    project.willCompile(
      new PendingStep(() => {
        startNew();
        return Promise.resolve([]);
      }),
    );
    await expect(send('does it compile?')).rejects.toThrow(RequestSupersededError);
    expect(agent.requests).toHaveLength(1);
  });
});

describe('preview / apply / reject', () => {
  it('applies an approved change and then compiles the project', async () => {
    project.willCompile([]);
    const changeId = await proposeEdit();
    progress = [];
    await expect(apply.execute(changeId, record)).resolves.toEqual({ kind: 'compiled' });
    expect(editor.lines).toEqual([...MAIN, 'Added.']);
    expect(editor.preview).toBeNull();
    const applied = conversation.messages().at(-1);
    expect(applied).toMatchObject({ id: changeId, kind: 'proposal', status: 'applied' });
    expect(storedMessages().at(-1)).toEqual(applied);
    expect(progress).toEqual([{ stage: 'decided', message: applied }, { stage: 'compiling' }]);
  });

  it('cancels the review compile of an applied change for a new conversation', async () => {
    const changeId = await proposeEdit();
    project.willCompile(new PendingStep(rejectOnAbort));
    const applying = apply.execute(changeId, record);
    await vi.waitFor(() => {
      expect(project.compileCalls).toBe(1);
    });
    startNew();
    await expect(applying).rejects.toThrow(RequestSupersededError);
    expect(editor.lines).toEqual([...MAIN, 'Added.']);
    expect(isBusy()).toBe(false);
  });

  it('cancels a file read of the agent for a new conversation', async () => {
    agent.will(readBib());
    project.holdsReads = true;
    const running = send('read the bibliography');
    await vi.waitFor(() => {
      expect(project.reads).toEqual(['refs.bib']);
    });
    startNew();
    await expect(running).rejects.toThrow(RequestSupersededError);
  });

  it('refuses a request while an applied change is being reviewed', async () => {
    const changeId = await proposeEdit();
    const compiled = Promise.withResolvers<readonly CompileDiagnostic[]>();
    project.willCompile(new PendingStep(() => compiled.promise));
    const applying = apply.execute(changeId, record);
    expect(isBusy()).toBe(true);
    await expect(send('what next?')).rejects.toThrow(RequestInProgressError);
    compiled.resolve([]);
    await expect(applying).resolves.toEqual({ kind: 'compiled' });
    expect(isBusy()).toBe(false);
  });

  it('opens the file of the change when the user switched away before Apply', async () => {
    project.willCompile([]);
    const changeId = await proposeEdit(readBib(), bibEdit());
    project.switchTo('main.tex');
    progress = [];
    await apply.execute(changeId, record);
    expect(project.opened).toEqual(['refs.bib', 'refs.bib']);
    expect(progress[0]).toEqual({ stage: 'opening', path: 'refs.bib' });
    expect(editor.lines).toEqual([...BIB, 'Added.']);
  });

  it('keeps the change for another Apply when its file cannot be opened', async () => {
    project.willCompile([]);
    const changeId = await proposeEdit(readBib(), bibEdit());
    project.switchTo('main.tex');
    project.failure.openFile = new FileOpenTimeoutError('slow');
    await expect(apply.execute(changeId, record)).rejects.toThrow(FileOpenTimeoutError);
    expect(editor.applied).toHaveLength(0);
    expect(conversation.messages().at(-1)).toMatchObject({ id: changeId, status: 'proposed' });
    project.failure = {};
    await expect(apply.execute(changeId, record)).resolves.toEqual({ kind: 'compiled' });
    expect(editor.lines).toEqual([...BIB, 'Added.']);
  });

  it('keeps the change for another Apply when the editor vanished before the write', async () => {
    const changeId = await proposeEdit();
    editor.available = false;
    await expect(apply.execute(changeId, record)).rejects.toThrow(EditorUnavailableError);
    expect(progress.filter((p) => p.stage === 'decided')).toEqual([]);
    expect(pendingChanges.isPending(changeId)).toBe(true);
    await expect(reject.execute(changeId)).resolves.toMatchObject({ status: 'rejected' });
  });

  it('records a change whose write failed as failed', async () => {
    const changeId = await proposeEdit();
    progress = [];
    editor.applyFailure = new EditorShowsOtherFileError('switched');
    await expect(apply.execute(changeId, record)).rejects.toThrow(EditorShowsOtherFileError);
    const failed = { id: changeId, kind: 'proposal', status: 'failed' };
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ stage: 'decided', message: failed });
    expect(storedMessages().at(-1)).toMatchObject(failed);
    await expect(apply.execute(changeId, record)).rejects.toThrow(ChangeNoLongerPendingError);
  });

  it('keeps the failure of the write when recording it fails as well', async () => {
    const changeId = await proposeEdit();
    const writeFailure = new EditorShowsOtherFileError('switched');
    editor.applyFailure = writeFailure;
    const recordingFailure = new InvariantViolation('view broken');
    const failing = apply.execute(changeId, (p) => {
      if (p.stage === 'decided') throw recordingFailure;
    });
    await expect(failing).rejects.toMatchObject({
      name: 'FailureRecordingError',
      failure: writeFailure,
      cause: recordingFailure,
    });
  });

  it('leaves a change discarded by a new conversation during Apply discarded', async () => {
    const changeId = await proposeEdit(readBib(), bibEdit());
    project.switchTo('main.tex');
    project.onOpen = () => {
      startNew();
    };
    await expect(apply.execute(changeId, record)).rejects.toThrow(RequestSupersededError);
    expect(editor.applied).toHaveLength(0);
    expect(pendingChanges.isPending(changeId)).toBe(false);
  });

  it('rejects a change and keeps its proposal in the conversation as rejected', async () => {
    const changeId = await proposeEdit();
    const rejected = await reject.execute(changeId);
    expect(rejected).toMatchObject({ id: changeId, kind: 'proposal', status: 'rejected' });
    expect(conversation.messages().at(-1)).toEqual(rejected);
    expect(storedMessages().at(-1)).toEqual(rejected);
    expect(editor.preview).toBeNull();
    expect(editor.lines).toEqual(MAIN);
  });

  it('refuses a double apply', async () => {
    project.willCompile([]);
    const changeId = await proposeEdit();
    await apply.execute(changeId, record);
    await expect(apply.execute(changeId, record)).rejects.toThrow(ChangeNoLongerPendingError);
    expect(editor.applied).toHaveLength(1);
  });

  it('refuses apply after reject and reject after apply', async () => {
    project.willCompile([]);
    const first = await proposeEdit();
    await reject.execute(first);
    await expect(apply.execute(first, record)).rejects.toThrow(ChangeNoLongerPendingError);
    const second = await proposeEdit();
    await apply.execute(second, record);
    await expect(reject.execute(second)).rejects.toThrow(ChangeNoLongerPendingError);
  });

  it('refuses to reject a change while it is being applied', async () => {
    const changeId = await proposeEdit();
    const compiled = Promise.withResolvers<readonly CompileDiagnostic[]>();
    project.willCompile(new PendingStep(() => compiled.promise));
    const applying = apply.execute(changeId, record);
    await expect(reject.execute(changeId)).rejects.toThrow(RequestInProgressError);
    compiled.resolve([]);
    await expect(applying).resolves.toEqual({ kind: 'compiled' });
  });

  it('forgets closed changes at once', async () => {
    project.willCompile([]);
    const applied = await proposeEdit();
    await apply.execute(applied, record);
    const rejected = await proposeEdit();
    await reject.execute(rejected);
    expect(pendingChanges.isPending(applied)).toBe(false);
    expect(pendingChanges.isPending(rejected)).toBe(false);
    expect(pendingChanges.discardAll()).toEqual([]);
  });

  it('detects a document changed between preview and apply', async () => {
    const changeId = await proposeEdit();
    editor.lines[0] = '\\section{Introduction}';
    await expect(apply.execute(changeId, record)).rejects.toThrow(DocumentConflictError);
    expect(editor.applied).toHaveLength(0);
    expect(conversation.messages().at(-1)).toMatchObject({ id: changeId, status: 'failed' });
    await expect(apply.execute(changeId, record)).rejects.toThrow(ChangeNoLongerPendingError);
  });

  it('detects a target that disappeared', async () => {
    const changeId = await proposeEdit();
    editor.lines.pop();
    await expect(apply.execute(changeId, record)).rejects.toThrow(DocumentConflictError);
    await expect(apply.execute(changeId, record)).rejects.toThrow(ChangeNoLongerPendingError);
  });
});

describe('ReviewAppliedChange', () => {
  const reviewApplied = () => lock.run((signal) => review.execute(record, signal));

  beforeEach(() => {
    conversation.append({ id: 'request', role: 'user', text: 'Make it bold.' });
  });

  it('fixes compile errors only inside a running operation', async () => {
    await expect(handle.fixCompileErrors([], record, new AbortController().signal)).rejects.toThrow(
      InvariantViolation,
    );
  });

  it('reports a clean compilation without asking the agent', async () => {
    project.willCompile([{ level: 'warning', message: 'Overfull \\hbox.' }]);
    await expect(reviewApplied()).resolves.toEqual({ kind: 'compiled' });
    expect(agent.requests).toHaveLength(0);
    expect(progress).toEqual([{ stage: 'compiling' }]);
  });

  it('records the fix request as a system request, not as a user message', async () => {
    project.willCompile([{ level: 'error' as const, message: 'x' }]);
    agent.will(answer('Fixed nothing.'));
    await reviewApplied();
    expect(conversation.messages()[1]).toEqual({
      id: anInstanceOf(String),
      role: 'system',
      text: COMPILE_FIX_REQUEST,
    });
    expect(progress[1]).toMatchObject({ stage: 'received', message: { role: 'system' } });
  });

  it('asks the agent for a fix with the compile result attached to the request', async () => {
    const diagnostics = [
      { level: 'error' as const, message: 'Undefined control sequence.', path: 'main.tex' },
    ];
    project.willCompile(diagnostics);
    agent.will(mainEdit());
    const outcome = await reviewApplied();
    expect(outcome).toMatchObject({ kind: 'fix', result: { message: { kind: 'proposal' } } });
    expect(agent.requests[0]).toMatchObject({
      request: {
        kind: 'compile-fix',
        message: { role: 'system', text: COMPILE_FIX_REQUEST },
        diagnostics,
      },
      transcript: [],
    });
    expect(project.compileCalls).toBe(1);
  });

  it('drops the review when the conversation was reset during compilation', async () => {
    project.willCompile(
      new PendingStep(() => {
        startNew();
        return Promise.resolve([{ level: 'error' as const, message: 'x' }]);
      }),
    );
    await expect(reviewApplied()).rejects.toThrow(RequestSupersededError);
    expect(agent.requests).toHaveLength(0);
  });
});

describe('conversation', () => {
  it('restores the latest session and starts a new one without deleting it', async () => {
    seed(storedSession('old', [{ id: 'a', role: 'user', text: 'older' }], 1));
    seed(storedSession('latest', [{ id: 'b', role: 'user', text: 'latest' }], 2));
    await restore();
    expect(conversation.messages()).toEqual([{ id: 'b', role: 'user', text: 'latest' }]);
    expect(conversation.sessionId).toBe('latest');
    const changeId = await proposeEdit();
    startNew();
    expect(conversation.messages()).toHaveLength(0);
    expect(conversation.sessionId).toBeNull();
    expect(repository.stored.get('latest')?.messages.at(-1)).toMatchObject({
      id: changeId,
      status: 'discarded',
    });
    await expect(apply.execute(changeId, record)).rejects.toThrow(ChangeNoLongerPendingError);
    agent.will(answer('Fresh.'));
    await send('fresh start');
    expect(conversation.sessionId).toBe('session-1');
    expect(repository.stored.get('session-1')).toMatchObject({
      title: 'fresh start',
      messages: [{ role: 'user', text: 'fresh start' }, { text: 'Fresh.' }],
    });
    expect(repository.stored.size).toBe(3);
  });

  it('starts with a new session when none is stored', async () => {
    await restore();
    expect(conversation.messages()).toEqual([]);
    expect(conversation.sessionId).toBeNull();
    expect(repository.stored.size).toBe(0);
  });

  it('restores while holding the operation lock', async () => {
    const restoring = restore();
    expect(isBusy()).toBe(true);
    await expect(send('too early')).rejects.toThrow(RequestInProgressError);
    await restoring;
    expect(isBusy()).toBe(false);
  });

  it('discards the proposals a reload left undecided', async () => {
    const undecided = {
      id: 'p',
      role: 'assistant' as const,
      kind: 'proposal' as const,
      path: 'main.tex',
      command: createDocumentCommand({
        operation: 'delete',
        target: { lineNumber: 1, lineText: itemAt(MAIN, 0, 'line') },
      }),
      status: 'proposed' as const,
    };
    seed(storedSession('s', [{ id: 'u', role: 'user', text: 'delete it' }, undecided]));
    const discarded = { ...undecided, status: 'discarded' };
    await restore();
    expect(conversation.messages()).toEqual([
      { id: 'u', role: 'user', text: 'delete it' },
      discarded,
    ]);
    expect(storedMessages().at(-1)).toEqual(discarded);
    expect(repository.only().updatedAt).toBe(1);
  });

  it('records when a session started and last changed', async () => {
    agent.will(answer('One.'), answer('Two.'));
    await send('  first\n request ');
    await send('second');
    expect(repository.only()).toMatchObject({
      id: 'session-1',
      title: 'first request',
      createdAt: 1,
      updatedAt: 4,
    });
  });

  it('keeps working when storage fails and reports it once', async () => {
    repository.failing = true;
    agent.will(answer('Hi.'));
    const result = await send('hello');
    expect(result.message.kind).toBe('explanation');
    expect(conversation.messages()).toHaveLength(2);
    expect((await conversation.takePersistenceFailure())?.message).toBe('storage off');
    await expect(conversation.takePersistenceFailure()).resolves.toBeNull();
  });

  it('reports storage that cannot list the sessions', async () => {
    repository.failing = true;
    await expect(restore()).rejects.toThrow(SessionStorageError);
    expect(isBusy()).toBe(false);
  });

  it('starts a session only with a request of the user', () => {
    expect(() => {
      conversation.append({ id: 's', role: 'system', text: COMPILE_FIX_REQUEST });
    }).toThrow(InvariantViolation);
  });

  it('keeps only the last 80 messages', async () => {
    for (let i = 0; i < 45; i += 1) {
      agent.will(answer('Hi.'));
      await send('hi');
    }
    expect(storedMessages()).toHaveLength(80);
  });
});

describe('sessions', () => {
  const older = storedSession('older', [{ id: 'o', role: 'user', text: 'older' }], 1);
  const proposalOf = (id: string, status: 'proposed' | 'applied') => ({
    id,
    role: 'assistant' as const,
    kind: 'proposal' as const,
    path: 'main.tex',
    command: createDocumentCommand({
      operation: 'delete',
      target: { lineNumber: 1, lineText: itemAt(MAIN, 0, 'line') },
    }),
    status,
  });
  const decided = storedSession(
    'decided',
    [{ id: 'd', role: 'user', text: 'delete it' }, proposalOf('applied', 'applied')],
    5,
  );

  beforeEach(() => {
    seed(older);
    seed(decided);
  });

  it('lists the sessions newest first with the current and the unreadable ones', async () => {
    repository.unreadableIds = ['broken'];
    await openSession('older');
    await expect(listSessions()).resolves.toEqual({
      sessions: [
        { id: 'decided', title: 'Session decided', createdAt: 0, updatedAt: 5, messageCount: 2 },
        { id: 'older', title: 'Session older', createdAt: 0, updatedAt: 1, messageCount: 1 },
      ],
      unreadableIds: ['broken'],
      currentId: 'older',
    });
  });

  it('opens a session with its decisions and continues it', async () => {
    await openSession('decided');
    expect(conversation.sessionId).toBe('decided');
    expect(conversation.messages()).toEqual(decided.messages);
    agent.will(answer('Done before.'));
    await send('was it applied?');
    expect(repository.stored.get('decided')).toMatchObject({
      title: 'Session decided',
      messages: [
        { id: 'd' },
        { id: 'applied' },
        { text: 'was it applied?' },
        { kind: 'explanation' },
      ],
    });
    expect(repository.stored.get('older')).toEqual(older);
  });

  it('discards the proposals left undecided in the opened session', async () => {
    seed(
      storedSession('open', [{ id: 'u', role: 'user', text: 'x' }, proposalOf('p', 'proposed')]),
    );
    await openSession('open');
    expect(conversation.messages().at(-1)).toMatchObject({ id: 'p', status: 'discarded' });
    expect(repository.stored.get('open')?.messages.at(-1)).toMatchObject({ status: 'discarded' });
  });

  it('discards the pending change of the session it leaves', async () => {
    const changeId = await proposeEdit();
    const left = conversation.sessionId;
    if (left === null) throw new TestFixtureError('the request started no session');
    await openSession('older');
    expect(editor.preview).toBeNull();
    expect(conversation.messages()).toEqual(older.messages);
    expect(repository.stored.get(left)?.messages.at(-1)).toMatchObject({
      id: changeId,
      status: 'discarded',
    });
    await expect(apply.execute(changeId, record)).rejects.toThrow(ChangeNoLongerPendingError);
  });

  it('keeps the current session when the opened one cannot be loaded', async () => {
    await openSession('older');
    repository.unreadableIds = ['decided'];
    await expect(openSession('decided')).rejects.toThrow(UnreadableSessionError);
    await expect(openSession('gone')).rejects.toThrow(SessionNotFoundError);
    expect(conversation.sessionId).toBe('older');
    expect(isBusy()).toBe(false);
  });

  it('refuses to open or delete a session while an operation runs', async () => {
    agent.will(new PendingStep(rejectOnAbort));
    const running = send('summarize');
    await vi.waitFor(() => {
      expect(agent.requests).toHaveLength(1);
    });
    const current = conversation.sessionId;
    await expect(openSession('older')).rejects.toThrow(RequestInProgressError);
    await expect(deleteSession('older')).rejects.toThrow(RequestInProgressError);
    expect(conversation.sessionId).toBe(current);
    expect(repository.stored.has('older')).toBe(true);
    startNew();
    await expect(running).rejects.toThrow(RequestSupersededError);
  });

  it('holds the operation lock while it opens a session', async () => {
    const loaded = Promise.withResolvers<undefined>();
    repository.loadsHeldUntil = loaded.promise;
    const opening = openSession('older');
    expect(isBusy()).toBe(true);
    await expect(send('too early')).rejects.toThrow(RequestInProgressError);
    loaded.resolve(undefined);
    await opening;
    expect(conversation.sessionId).toBe('older');
  });

  it('drops a session that finishes loading after a new conversation started', async () => {
    const loaded = Promise.withResolvers<undefined>();
    repository.loadsHeldUntil = loaded.promise;
    const opening = openSession('older');
    startNew();
    loaded.resolve(undefined);
    await expect(opening).rejects.toThrow(RequestSupersededError);
    expect(conversation.sessionId).toBeNull();
    expect(conversation.messages()).toEqual([]);
  });

  it('deletes another session and keeps the current one', async () => {
    await openSession('decided');
    await deleteSession('older');
    expect(repository.stored.has('older')).toBe(false);
    expect(conversation.sessionId).toBe('decided');
  });

  it('deletes the current session and starts a new conversation', async () => {
    const changeId = await proposeEdit();
    const current = conversation.sessionId;
    if (current === null) throw new TestFixtureError('the request started no session');
    await deleteSession(current);
    expect(repository.stored.has(current)).toBe(false);
    expect(conversation.sessionId).toBeNull();
    expect(conversation.messages()).toEqual([]);
    expect(editor.preview).toBeNull();
    await expect(apply.execute(changeId, record)).rejects.toThrow(ChangeNoLongerPendingError);
    await expect(conversation.takePersistenceFailure()).resolves.toBeNull();
    expect(repository.stored.has(current)).toBe(false);
  });

  it('reports a session it could not delete and leaves it listed', async () => {
    await openSession('decided');
    repository.failing = true;
    await expect(deleteSession('decided')).rejects.toThrow(SessionStorageError);
    repository.failing = false;
    expect(conversation.sessionId).toBeNull();
    await expect(listSessions()).resolves.toMatchObject({
      sessions: [{ id: 'decided' }, { id: 'older' }],
    });
  });
});
