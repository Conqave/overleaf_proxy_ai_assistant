import {
  ExportSession,
  ImportSession,
  ListSessionExports,
} from '../../../src/application/session-exchange';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ApplyChangeSet } from '../../../src/application/apply-change-set';
import { CompactConversation } from '../../../src/application/compact-conversation';
import { ConversationCompactor } from '../../../src/application/conversation-compactor';
import { ConversationLog } from '../../../src/application/conversation-log';
import {
  DeleteSession,
  ListSessions,
  OpenSession,
  RestoreLatestSession,
  StartNewConversation,
} from '../../../src/application/conversation-session';
import { HandleAssistantRequest } from '../../../src/application/handle-assistant-request';
import { OperationLock } from '../../../src/application/operation-lock';
import { PendingChanges } from '../../../src/application/pending-change';
import { PreviewChangeSetFile } from '../../../src/application/preview-change-set-file';
import { RejectChangeSet } from '../../../src/application/reject-change-set';
import { UndoChangeSet } from '../../../src/application/undo-change-set';
import { ReviewAppliedChange } from '../../../src/application/review-applied-change';
import { WebSearchApproval, WebSearchDecision } from '../../../src/application/web-search-approval';
import { WebSearchTool } from '../../../src/application/web-search-tool';
import type { AgentDecision } from '../../../src/domain/agent-action';
import type { CompileDiagnostic } from '../../../src/domain/agent-transcript';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { InvariantViolation } from '../../../src/domain/errors';
import type { ConversationSession } from '../../../src/domain/session';
import {
  AssistantUnreachableError,
  FileOpenTimeoutError,
  WebSearchUnavailableError,
} from '../../../src/ports/errors';
import { AssistantController } from '../../../src/presentation/assistant-controller';
import { AssistantView } from '../../../src/presentation/assistant-view';
import { LocalStoragePanelSize } from '../../../src/infrastructure/persistence/local-storage-panel-size';
import {
  coverAllButLastTurn,
  FakeAgent,
  FakeEditor,
  FakeProject,
  FakeSummarizer,
  FakeWebSearch,
  InMemorySessionArchive,
  InMemorySessionRepository,
  PendingStep,
  sequentialIds,
  storedSession,
  ticking,
} from '../../support/fakes';
import { TestFixtureError } from '../../support/test-errors';

const BIB = ['@article{smith20}', '}'];

const READ_BIB: AgentDecision = { kind: 'tool', call: { tool: 'read_file', path: 'refs.bib' } };

const ADD_BOOK = {
  path: 'refs.bib',
  command: createDocumentCommand({
    operation: 'insert_after',
    target: { lineNumber: 2, lineText: '}' },
    content: '@book{knuth84}',
    reason: 'Adds the missing entry.',
  }),
};

const CITE_BOOK = {
  path: 'main.tex',
  command: createDocumentCommand({
    operation: 'replace',
    target: { lineNumber: 1, lineText: '\\cite{knuth84}' },
    content: '\\cite{knuth84, smith20}',
  }),
};

function openAssistant(...stored: ConversationSession[]) {
  return openAssistantWith(
    [READ_BIB, { kind: 'reply', reply: { kind: 'edit', edits: [ADD_BOOK] } }],
    ...stored,
  );
}

async function openAssistantWith(
  decisions: readonly AgentDecision[],
  ...stored: ConversationSession[]
) {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const editor = new FakeEditor([]);
  const project = new FakeProject(
    editor,
    { 'main.tex': ['\\cite{knuth84}'], 'refs.bib': BIB },
    'main.tex',
  );
  const agent = new FakeAgent().will(...decisions);
  const sessions = new InMemorySessionRepository(...stored);
  const conversation = new ConversationLog({
    sessions,
    newId: sequentialIds('session'),
    now: ticking(),
  });
  const pendingChanges = new PendingChanges(conversation);
  const lock = new OperationLock(() => new AbortController());
  const newId = sequentialIds();
  const summarizer = new FakeSummarizer();
  const compactor = new ConversationCompactor({
    agent,
    summarizer,
    conversation,
    newId,
    now: () => new Date('2026-10-01T12:00:00Z'),
  });
  const webSearch = new FakeWebSearch();
  const webSearchApproval = new WebSearchApproval({ conversation, newId });
  const handleRequest = new HandleAssistantRequest({
    agent,
    project,
    editor,
    conversation,
    pendingChanges,
    lock,
    newId,
    createController: () => new AbortController(),
    compactor,
    webSearch: new WebSearchTool({ search: webSearch, approval: webSearchApproval }),
  });
  const review = new ReviewAppliedChange({ project, conversation, handleRequest });
  const sessionDeps = { sessions, conversation, pendingChanges, editor, lock };
  const changeSetDeps = { project, editor, pendingChanges, review };
  const exchangeDeps = {
    ...sessionDeps,
    archive: new InMemorySessionArchive(),
    project,
    scope: { userId: 'user-1', projectId: 'project-1' },
    newId,
    now: () => 1,
  };
  const controller = new AssistantController({
    handleRequest,
    lock,
    applyChange: new ApplyChangeSet({ ...changeSetDeps, conversation, lock }),
    rejectChange: new RejectChangeSet({ ...changeSetDeps, lock }),
    previewChange: new PreviewChangeSetFile({
      project,
      editor,
      pendingChanges,
      conversation,
      lock,
    }),
    undoChange: new UndoChangeSet({ project, editor, conversation, lock, newId }),
    compactConversation: new CompactConversation({ compactor, conversation, lock }),
    restoreSession: new RestoreLatestSession(sessionDeps),
    startNewConversation: new StartNewConversation(sessionDeps),
    listSessions: new ListSessions(sessionDeps),
    openSession: new OpenSession(sessionDeps),
    deleteSession: new DeleteSession(sessionDeps),
    exportSession: new ExportSession(exchangeDeps),
    listSessionExports: new ListSessionExports(exchangeDeps),
    importSession: new ImportSession(exchangeDeps),
    webSearchApproval,
    conversation,
  });
  await controller.attach(
    new AssistantView(window.document, controller, new LocalStoragePanelSize(window)),
  );
  const texts = (selector: string) =>
    Array.from(window.document.querySelectorAll(selector)).map((n) => n.textContent);
  const click = (selector: string) => {
    const button = window.document.querySelector(selector);
    if (!(button instanceof window.HTMLButtonElement)) {
      throw new TestFixtureError(`the view shows no ${selector} button`);
    }
    button.click();
  };
  const buttons = (selector: string) =>
    Array.from(window.document.querySelectorAll(selector)).filter(
      (node) => node instanceof window.HTMLButtonElement,
    );
  return {
    window,
    controller,
    conversation,
    sessions,
    editor,
    project,
    agent,
    summarizer,
    webSearch,
    texts,
    click,
    buttons,
  };
}

async function proposeBibEdit() {
  const assistant = await openAssistant();
  await assistant.controller.send('add the knuth84 entry');
  const proposal = assistant.conversation.messages().at(-1);
  if (proposal?.role !== 'assistant' || proposal.kind !== 'proposal') {
    throw new TestFixtureError('the controller did not show a proposal');
  }
  return { ...assistant, changeId: proposal.id };
}

describe('AssistantController subagent', () => {
  const TASK = 'Check every \\cite key against refs.bib';
  const answer = (text: string): AgentDecision => ({
    kind: 'reply',
    reply: { kind: 'answer', text },
  });

  it('shows the subagent at work, its context use and its findings collapsed', async () => {
    let statusWhileDelegating: (string | null)[] = [];
    let contextWhileDelegating: (string | null)[] = [];
    const { window, controller, agent, texts } = await openAssistantWith([
      { kind: 'tool', call: { tool: 'delegate', task: TASK, files: ['refs.bib'] } },
      READ_BIB,
    ]);
    agent.onDecide = (request) => {
      if (request.request.kind !== 'subtask' || request.transcript.length !== 1) return;
      statusWhileDelegating = texts('.ola-status');
      contextWhileDelegating = texts('.ola-context');
    };
    agent.will(answer('**knuth84** is missing from refs.bib.'), answer('knuth84 is missing.'));
    await controller.send('are my citations defined?');
    expect(statusWhileDelegating).toEqual(['Hans: subagent reviewing 1 file…']);
    expect(contextWhileDelegating).toEqual(['Context 2.0k / 98.3k']);
    const card = window.document.querySelector('details.ola-delegation');
    expect(card?.hasAttribute('open')).toBe(false);
    expect(texts('.ola-delegation-title')).toEqual([`Subagent result: ${TASK}`]);
    expect(texts('.ola-delegation-body strong')).toEqual(['knuth84']);
    expect(texts('.ola-delegation .ola-result-meta')).toEqual(['1 lookup · files: refs.bib']);
    expect(texts('.ola-msg').slice(-2)).toEqual([
      expect.stringContaining('Subagent result'),
      expect.stringContaining('knuth84 is missing.'),
    ]);
    expect(texts('.ola-context')).toEqual(['Context 4.0k / 98.3k']);
  });

  it('shows a failed delegation as stopped and keeps other lookups out of the chat', async () => {
    const { controller, texts } = await openAssistantWith([
      READ_BIB,
      { kind: 'tool', call: { tool: 'delegate', task: TASK, files: [] } },
      ...Array.from({ length: 3 }, (): AgentDecision => ({
        kind: 'tool',
        call: { tool: 'compile' },
      })),
      answer('The check stopped.'),
    ]);
    await controller.send('are my citations defined?');
    expect(texts('.ola-delegation-title')).toEqual([`Subagent stopped: ${TASK}`]);
    expect(texts('details.ola-delegation.is-failed .ola-delegation-body')).toEqual([
      expect.stringContaining('the subagent stopped after 3 invalid steps in a row'),
    ]);
    expect(texts('.ola-msg')).toHaveLength(3);
  });
});

describe('AssistantController web search', () => {
  const QUERY = 'Leslie Lamport LaTeX book DOI';
  const SEARCH: AgentDecision = { kind: 'tool', call: { tool: 'web_search', query: QUERY } };
  const answer = (text: string): AgentDecision => ({
    kind: 'reply',
    reply: { kind: 'answer', text },
  });
  const RESULTS = [
    {
      title: 'Latex: a document preparation system',
      url: 'https://dl.acm.org/doi/abs/10.5555/63364',
      snippet: 'Leslie Lamport',
      published: '1986',
    },
    { title: 'LaTeX book', url: 'http://example.org/latex', snippet: '' },
  ];

  async function waitForApprovalCard({ document }: { document: Document }): Promise<void> {
    await vi.waitFor(() => {
      expect(document.querySelector('.ola-approval')).not.toBeNull();
    });
  }

  it('asks for approval inline, then shows the status and the results collapsed with links', async () => {
    const assistant = await openAssistantWith([SEARCH, answer('The DOI is 10.5555/63364.')]);
    const { window, controller, webSearch, texts, click, buttons } = assistant;
    let statusWhileSearching: (string | null)[] = [];
    webSearch.will(
      new PendingStep(() => {
        statusWhileSearching = texts('.ola-status');
        return Promise.resolve(RESULTS);
      }),
    );
    const running = controller.send('find the DOI of the LaTeX book');
    await waitForApprovalCard(window);
    expect(texts('.ola-approval .ola-result-title')).toEqual(['Hans wants to search the web']);
    expect(texts('.ola-approval-query')).toEqual([QUERY]);
    expect(texts('.ola-approval .ola-result-meta')).toEqual([
      'Exa (exa.ai), an external search service, receives this query.',
    ]);
    expect(texts('.ola-approval-option')).toEqual(['Auto-approve web searches in this session']);
    expect(texts('.ola-status')).toEqual(['Hans is waiting for your approval of a web search']);
    expect(buttons('.ola-send').every((button) => button.disabled)).toBe(true);
    expect(buttons('.ola-approval button').every((button) => !button.disabled)).toBe(true);
    click('.ola-approve-search');
    await running;
    expect(statusWhileSearching).toEqual([`Hans is searching the web for ${QUERY}`]);
    expect(window.document.querySelector('.ola-approval')).toBeNull();
    const card = window.document.querySelector('details.ola-web-search');
    expect(card?.hasAttribute('open')).toBe(false);
    expect(texts('.ola-web-search-title')).toEqual([`Web search: ${QUERY}`]);
    expect(texts('.ola-web-search .ola-result-meta')).toEqual(['2 results']);
    expect(texts('.ola-web-source')).toEqual(['dl.acm.org · 1986', 'example.org']);
    const links = Array.from(window.document.querySelectorAll('a.ola-web-link'));
    expect(
      links.map((link) => ({
        text: link.textContent,
        href: link.getAttribute('href'),
        target: link.getAttribute('target'),
        rel: link.getAttribute('rel'),
      })),
    ).toEqual(
      RESULTS.map(({ title, url }) => ({
        text: title,
        href: url,
        target: '_blank',
        rel: 'noopener noreferrer',
      })),
    );
    expect(webSearch.queries).toEqual([QUERY]);
  });

  it('shows a denied search and lets the agent go on without it', async () => {
    const assistant = await openAssistantWith([SEARCH, answer('I could not search.')]);
    const { window, controller, webSearch, texts, click } = assistant;
    const running = controller.send('find the DOI');
    await waitForApprovalCard(window);
    click('.ola-deny-search');
    await running;
    expect(webSearch.queries).toEqual([]);
    expect(window.document.querySelector('.ola-approval')).toBeNull();
    expect(texts('details.ola-web-search.is-denied .ola-web-search-title')).toEqual([
      `Web search denied: ${QUERY}`,
    ]);
    expect(texts('.ola-msg').at(-1)).toContain('I could not search.');
  });

  it('stops asking in this session once the user auto-approves', async () => {
    const assistant = await openAssistantWith([
      SEARCH,
      { kind: 'tool', call: { tool: 'web_search', query: 'LaTeX book publisher' } },
      answer('Found both.'),
    ]);
    const { window, controller, webSearch, click } = assistant;
    webSearch.will(RESULTS, []);
    const running = controller.send('find the DOI and the publisher');
    await waitForApprovalCard(window);
    const option = window.document.querySelector('.ola-approval-session');
    if (!(option instanceof window.HTMLInputElement)) {
      throw new TestFixtureError('the approval card has no session option');
    }
    option.checked = true;
    click('.ola-approve-search');
    await running;
    expect(webSearch.queries).toEqual([QUERY, 'LaTeX book publisher']);
    expect(window.document.querySelectorAll('.ola-approval')).toHaveLength(0);
  });

  it('shows a failed search with its problem and reports a stale decision', async () => {
    const assistant = await openAssistantWith([SEARCH, answer('Search is down.')]);
    const { window, controller, webSearch, texts, click } = assistant;
    webSearch.will(new WebSearchUnavailableError('Exa web search is unavailable: HTTP 502.'));
    const running = controller.send('find the DOI');
    await waitForApprovalCard(window);
    click('.ola-approve-search');
    await running;
    expect(texts('details.ola-web-search.is-failed .ola-fold-body')).toEqual([
      'Exa web search is unavailable: HTTP 502.',
    ]);
    await controller.decideWebSearch('id-404', WebSearchDecision.Approve);
    expect(texts('.ola-error').at(-1)).toBe(
      'Error: This web search no longer waits for a decision.',
    );
  });

  it('shows stored web searches again when a session is reopened', async () => {
    const { texts } = await openAssistant(
      storedSession('stored', [
        { id: 'u', role: 'user', text: 'find the DOI' },
        {
          id: 't',
          role: 'tool',
          record: {
            tool: 'web_search',
            query: QUERY,
            outcome: { status: 'found', results: RESULTS, truncated: true },
          },
        },
      ]),
    );
    expect(texts('.ola-web-search-title')).toEqual([`Web search: ${QUERY}`]);
    expect(texts('.ola-web-search .ola-result-meta')).toEqual(['2 results · excerpts shortened']);
  });
});

describe('AssistantController compaction', () => {
  it('offers Compact only for earlier turns and shows the summary as a notice', async () => {
    const { window, controller, agent, summarizer, texts } = await proposeBibEdit();
    const compact = () => {
      const found = window.document.querySelector<HTMLButtonElement>('.ola-compact');
      if (found === null) throw new TestFixtureError('the panel has no Compact button');
      return found;
    };
    agent.plan = (trigger) => (trigger.kind === 'manual' ? coverAllButLastTurn(trigger) : null);
    expect(compact().textContent).toBe('Compact');
    expect(texts('.ola-head-row > *')).toEqual(['Hans AI Assistant', 'Context 2.0k / 98.3k']);
    expect(texts('.ola-head-actions > button')).toEqual(['Compact', 'Sessions', 'New']);
    expect(compact().title).toBe('Compact context now: summarise the earlier conversation');
    expect(compact().disabled).toBe(true);
    agent.will({ kind: 'reply', reply: { kind: 'answer', text: 'Smith is cited.' } });
    await controller.send('who is cited?');
    expect(compact().disabled).toBe(false);
    summarizer.will('## Goal\nAdd the knuth84 entry.');
    compact().click();
    await vi.waitFor(() => {
      expect(texts('.ola-compaction-title')).toEqual([
        'Context compacted: 5.0k → 3.0k (summary of 1 turn)',
      ]);
    });
    expect(texts('.ola-compaction-body h2')).toEqual(['Goal']);
    expect(texts('.ola-compaction-body p')).toEqual(['Add the knuth84 entry.']);
    expect(texts('.ola-status')).toEqual(['']);
    expect(compact().disabled).toBe(true);
  });

  it('reports that there is nothing to compact', async () => {
    const { controller, texts } = await openAssistant();
    await controller.compact();
    expect(texts('.ola-error')).toEqual([
      'Error: There is nothing to compact yet: the latest turn always stays in full.',
    ]);
  });
});

describe('AssistantController context usage', () => {
  it('shows an unused context window before the first request', async () => {
    const { texts } = await openAssistant();
    expect(texts('.ola-context')).toEqual(['Context 0 / 98.3k']);
  });

  it('shows the context usage of the last request and an unused window for a new chat', async () => {
    const { controller, texts } = await proposeBibEdit();
    expect(texts('.ola-context')).toEqual(['Context 2.0k / 98.3k']);
    await controller.newConversation();
    expect(texts('.ola-context')).toEqual(['Context 0 / 98.3k']);
  });

  it('shows the context usage of the fix proposed after a failed compilation', async () => {
    const { controller, project, agent, changeId, texts } = await proposeBibEdit();
    project.willCompile([{ level: 'error', message: 'Missing } inserted.' }]);
    agent.will({ kind: 'reply', reply: { kind: 'answer', text: 'Add a closing brace.' } });
    await controller.apply(changeId, null);
    expect(texts('.ola-context')).toEqual(['Context 3.0k / 98.3k']);
  });
});

describe('AssistantController apply', () => {
  it('reports the applied file and a clean compilation', async () => {
    const { controller, project, changeId, texts } = await proposeBibEdit();
    project.willCompile([]);
    await controller.apply(changeId, null);
    expect(texts('.ola-system')).toEqual([
      'Done. Inserted after the selected anchor in refs.bib.',
      'Compiled without errors.',
    ]);
  });

  it('keeps the applied proposal as a card marked applied', async () => {
    const { controller, project, changeId, texts } = await proposeBibEdit();
    project.willCompile([]);
    await controller.apply(changeId, null);
    expect(texts('.ola-ai.is-applied .ola-result-status')).toEqual(['Applied']);
    expect(texts('.ola-ai.is-applied .ola-result-meta')).toEqual(['refs.bib, anchor line 2: }']);
    expect(texts('.ola-apply')).toEqual([]);
  });
});

describe('AssistantController reject', () => {
  it('keeps the rejected proposal as a card marked rejected instead of a notice', async () => {
    const { controller, changeId, texts } = await proposeBibEdit();
    await controller.reject(changeId, null);
    expect(texts('.ola-ai.is-rejected .ola-result-status')).toEqual(['Rejected']);
    expect(texts('.ola-ai.is-rejected .ola-result-meta')).toEqual(['refs.bib, anchor line 2: }']);
    expect(texts('.ola-ai.is-rejected .ola-result-body')).toEqual(['@book{knuth84}']);
    expect(texts('.ola-apply')).toEqual([]);
    expect(texts('.ola-system')).toEqual([]);
  });

  it('shows the fix proposed after a failed compilation', async () => {
    const { controller, project, agent, changeId, texts } = await proposeBibEdit();
    project.willCompile([{ level: 'error', message: 'Missing } inserted.' }]);
    agent.will({ kind: 'reply', reply: { kind: 'answer', text: 'Add a closing brace.' } });
    await controller.apply(changeId, null);
    expect(texts('.ola-result-body').at(-1)).toBe('Add a closing brace.');
  });

  it('shows expected failures, marks the proposal not applied and continues', async () => {
    const { controller, editor, changeId, texts } = await proposeBibEdit();
    editor.lines[1] = 'Edited meanwhile.';
    await expect(controller.apply(changeId, null)).resolves.toBeUndefined();
    expect(texts('.ola-error')).toEqual([
      expect.stringContaining('The document changed after the suggestion was made.'),
    ]);
    expect(texts('.ola-ai.is-failed .ola-result-status')).toEqual(['Not applied']);
    expect(texts('.ola-apply')).toEqual([]);
    expect(texts('.ola-status')).toEqual(['']);
  });

  it('keeps Apply and Reject when the change could not be written yet', async () => {
    const { window, controller, project, changeId, texts } = await proposeBibEdit();
    project.switchTo('main.tex');
    project.failure.openFile = new FileOpenTimeoutError('refs.bib did not open in time.');
    await controller.apply(changeId, null);
    expect(texts('.ola-error')).toEqual(['Error: refs.bib did not open in time.']);
    expect(texts('.ola-result-status')).toEqual([]);
    const buttons = Array.from(window.document.querySelectorAll('.ola-result-actions button'));
    expect(buttons.map((node) => node.textContent)).toEqual(['Apply', 'Reject']);
    expect(
      buttons.every((node) => node instanceof window.HTMLButtonElement && !node.disabled),
    ).toBe(true);
  });

  it('marks a proposal discarded by the next request', async () => {
    const { controller, agent, texts } = await proposeBibEdit();
    agent.will({ kind: 'reply', reply: { kind: 'answer', text: 'Hello.' } });
    await controller.send('hello');
    expect(texts('.ola-ai.is-discarded .ola-result-status')).toEqual(['Discarded']);
    expect(texts('.ola-apply')).toEqual([]);
  });

  it('does not disguise defects as user errors', async () => {
    const { controller, editor, changeId, texts } = await proposeBibEdit();
    const defect = new InvariantViolation('broken');
    editor.applyFailure = defect;
    await expect(controller.apply(changeId, null)).rejects.toBe(defect);
    expect(texts('.ola-error')).toEqual([
      'Unexpected internal error. Details are in the browser console.',
    ]);
  });
});

describe('AssistantController change sets', () => {
  async function proposeTwoFiles() {
    const assistant = await openAssistantWith([
      READ_BIB,
      { kind: 'reply', reply: { kind: 'edit', edits: [CITE_BOOK, ADD_BOOK] } },
    ]);
    await assistant.controller.send('cite knuth84 and add its entry');
    const proposal = assistant.conversation.messages().at(-1);
    if (proposal?.role !== 'assistant' || proposal.kind !== 'proposal') {
      throw new TestFixtureError('the controller did not show a proposal');
    }
    const clickInFile = (file: number, selector: string) => {
      const group = assistant.window.document.querySelectorAll('.ola-change-file')[file];
      const button = group?.querySelector(selector);
      if (!(button instanceof assistant.window.HTMLButtonElement)) {
        throw new TestFixtureError(`file ${String(file)} shows no ${selector} button`);
      }
      button.click();
    };
    return { ...assistant, changeId: proposal.id, clickInFile };
  }

  it('shows the edits of several files in one card grouped by file', async () => {
    const { texts, buttons } = await proposeTwoFiles();
    expect(texts('.ola-ai .ola-result-title')).toEqual(['Proposed changes: 2 edits in 2 files']);
    expect(texts('.ola-change-path')).toEqual(['main.tex', 'refs.bib']);
    expect(texts('.ola-edit .ola-result-meta')).toEqual([
      'line 1: \\cite{knuth84}',
      'anchor line 2: }',
    ]);
    expect(texts('.ola-preview-file')).toEqual(['Show in editor', 'Show in editor']);
    expect(texts('.ola-edit-actions button')).toEqual(['Apply', 'Reject', 'Apply', 'Reject']);
    expect(texts('.ola-result-actions button')).toEqual(['Apply all', 'Reject all']);
    expect(buttons('.ola-ai button').every((button) => !button.disabled)).toBe(true);
  });

  it('applies one edit, keeps the other open and compiles after the last decision', async () => {
    const { project, editor, texts, click, clickInFile } = await proposeTwoFiles();
    project.willCompile([]);
    clickInFile(1, '.ola-apply-edit');
    await vi.waitFor(() => {
      expect(texts('.ola-ai > .ola-result-status')).toEqual(['1 applied · 1 open']);
    });
    expect(editor.lines).toEqual([...BIB, '@book{knuth84}']);
    expect(texts('.ola-system')).toEqual(['Done. Inserted after the selected anchor in refs.bib.']);
    expect(texts('.ola-edit.is-applied .ola-result-status')).toEqual(['Applied']);
    expect(texts('.ola-preview-file')).toEqual(['Show in editor']);
    click('.ola-reject-edit');
    await vi.waitFor(() => {
      expect(texts('.ola-system')).toContain('Compiled without errors.');
    });
    expect(texts('.ola-ai > .ola-result-status')).toEqual(['1 applied · 1 rejected']);
    expect(texts('.ola-ai button')).toEqual(['Undo this turn']);
    expect(project.savedDocument('main.tex')).toEqual(['\\cite{knuth84}']);
  });

  it('applies all files at once and reports a file that changed meanwhile', async () => {
    const { controller, project, editor, changeId, texts } = await proposeTwoFiles();
    project.switchTo('refs.bib');
    editor.lines[0] = '@article{changed}';
    project.switchTo('main.tex');
    project.willCompile([]);
    await controller.apply(changeId, null);
    expect(texts('.ola-system')).toEqual([
      'Done. Line replaced in main.tex.',
      'Compiled without errors.',
    ]);
    expect(texts('.ola-error')).toEqual([
      'Not applied in refs.bib: The document changed after the suggestion was made. Ask again to get a fresh suggestion.',
    ]);
    expect(texts('.ola-ai > .ola-result-status')).toEqual(['1 applied · 1 not applied']);
  });

  it('undoes the applied edits of a turn and records it as a notice', async () => {
    const { controller, project, editor, changeId, texts } = await proposeTwoFiles();
    project.willCompile([]);
    await controller.apply(changeId, null);
    expect(texts('.ola-undo')).toEqual(['Undo this turn']);
    await controller.undo(changeId);
    expect(editor.lines).toEqual(BIB);
    expect(project.savedDocument('main.tex')).toEqual(['\\cite{knuth84}']);
    expect(texts('.ola-ai > .ola-result-status')).toEqual(['Undone']);
    expect(texts('.ola-undo-notice')).toEqual([
      'Undone: main.tex, refs.bib are back as before this change.',
    ]);
    expect(texts('.ola-undo')).toEqual([]);
  });

  it('refuses to undo a file changed since and says so in the notice', async () => {
    const { controller, project, editor, changeId, texts } = await proposeTwoFiles();
    project.willCompile([]);
    await controller.apply(changeId, null);
    editor.lines[2] = '@book{knuth84, edited}';
    await controller.undo(changeId);
    expect(editor.lines).toEqual([...BIB, '@book{knuth84, edited}']);
    expect(texts('.ola-undo-notice > div')).toEqual([
      'Undone: main.tex is back as before this change.',
      'Not undone in refs.bib: refs.bib changed after Hans edited it: line 3 no longer holds the text Hans wrote there, so this file was left as it is.',
    ]);
    expect(texts('.ola-ai > .ola-result-status')).toEqual(['1 applied · 1 undone']);
    expect(texts('.ola-undo')).toEqual(['Undo this turn']);
  });

  it('previews the edits of another file on demand', async () => {
    const { project, editor, texts, clickInFile } = await proposeTwoFiles();
    clickInFile(1, '.ola-preview-file');
    await vi.waitFor(() => {
      expect(editor.preview?.map(({ command }) => command.target.lineNumber)).toEqual([2]);
    });
    expect(project.opened).toEqual(['refs.bib']);
    expect(texts('.ola-error')).toEqual([]);
  });
});

describe('AssistantController new chat', () => {
  it('shows nothing for a request the user cancelled with a new chat', async () => {
    const { controller, project, texts } = await openAssistant();
    project.holdsReads = true;
    const sending = controller.send('add the knuth84 entry');
    await vi.waitFor(() => {
      expect(project.reads).toEqual(['refs.bib']);
    });
    await controller.newConversation();
    await sending;
    expect(texts('.ola-error')).toEqual([]);
    expect(texts('.ola-msg')).toEqual([expect.stringContaining('Ready to help')]);
  });
});

describe('AssistantView while an operation runs', () => {
  function typingBubble(window: JSDOM['window']) {
    const bubble = window.document.querySelector<HTMLElement>('.ola-chat > .ola-typing');
    if (bubble === null) throw new TestFixtureError('the chat has no typing bubble');
    return {
      isShown: () => !bubble.hidden,
      isLast: () => bubble.parentElement?.lastElementChild === bubble,
      status: () => bubble.querySelector('.ola-status')?.textContent,
    };
  }

  it('shows the typing bubble with the status at the bottom while Hans works', async () => {
    const { window, controller, project, texts } = await openAssistant();
    const bubble = typingBubble(window);
    expect(bubble.isShown()).toBe(false);
    project.holdsReads = true;
    const sending = controller.send('add the knuth84 entry');
    await vi.waitFor(() => {
      expect(bubble.status()).toBe('Hans is reading refs.bib');
    });
    expect(bubble.isShown()).toBe(true);
    expect(bubble.isLast()).toBe(true);
    expect(texts('.ola-user')).toEqual(['add the knuth84 entry']);
    expect(
      window.document.querySelector('.ola-typing .ola-status')?.getAttribute('aria-live'),
    ).toBe('polite');
    await controller.newConversation();
    await sending;
    expect(bubble.isShown()).toBe(false);
    expect(bubble.isLast()).toBe(true);
    expect(bubble.status()).toBe('');
  });

  it('keeps the typing bubble in view when its status changes', async () => {
    const { window, controller, project } = await openAssistant();
    const chat = window.document.querySelector<HTMLElement>('.ola-chat');
    if (chat === null) throw new TestFixtureError('the view has no chat');
    let contentHeight = 400;
    Object.defineProperty(chat, 'scrollHeight', { get: () => contentHeight });
    project.holdsReads = true;
    const sending = controller.send('add the knuth84 entry');
    contentHeight = 900;
    await vi.waitFor(() => {
      expect(typingBubble(window).status()).toBe('Hans is reading refs.bib');
    });
    expect(chat.scrollTop).toBe(900);
    await controller.newConversation();
    await sending;
  });

  it('hides the typing bubble below the answer when the request ends', async () => {
    const { window, texts } = await proposeBibEdit();
    const bubble = typingBubble(window);
    expect(texts('.ola-result-title')).toEqual(['Proposed insertion']);
    expect(bubble.isShown()).toBe(false);
    expect(bubble.isLast()).toBe(true);
  });

  it('hides the typing bubble below the error when the request fails', async () => {
    const { window, controller, agent, texts } = await openAssistantWith([]);
    agent.will(new AssistantUnreachableError('Ollama is not reachable.'));
    await controller.send('who is cited?');
    const bubble = typingBubble(window);
    expect(texts('.ola-error')).toEqual(['Error: Ollama is not reachable.']);
    expect(bubble.isShown()).toBe(false);
    expect(bubble.isLast()).toBe(true);
    expect(bubble.status()).toBe('');
  });

  it('shows the busy state of the operation lock and ignores Enter until it ends', async () => {
    const { window, controller, project, changeId, texts } = await proposeBibEdit();
    const compiled = Promise.withResolvers<readonly CompileDiagnostic[]>();
    project.willCompile(new PendingStep(() => compiled.promise));
    const applying = controller.apply(changeId, null);
    const input = window.document.querySelector('textarea');
    if (input === null) throw new TestFixtureError('the view has no input');
    expect(window.document.querySelector('#ola-root')?.classList.contains('is-busy')).toBe(true);
    input.value = 'second request';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(input.value).toBe('second request');
    compiled.resolve([]);
    await applying;
    expect(texts('.ola-error')).toEqual([]);
    expect(texts('.ola-user')).toEqual(['add the knuth84 entry']);
    expect(window.document.querySelector('#ola-root')?.classList.contains('is-busy')).toBe(false);
  });
});

describe('AssistantController sessions', () => {
  const older = storedSession('older', [{ id: 'o', role: 'user', text: 'Explain the intro.' }], 1);
  const latest = storedSession(
    'latest',
    [
      { id: 'l', role: 'user', text: 'Fix the table.' },
      { id: 'a', role: 'assistant', kind: 'explanation', text: 'Fixed.' },
    ],
    2,
  );

  it('lists the sessions of the project newest first and marks the current one', async () => {
    const { controller, texts, buttons } = await openAssistant(older, latest);
    await controller.showSessions();
    expect(texts('.ola-session-title')).toEqual(['Session latest', 'Session older']);
    expect(texts('.ola-session.is-current .ola-session-title')).toEqual(['Session latest']);
    expect(texts('.ola-session-meta')).toEqual([
      expect.stringMatching(/ · 2 messages$/),
      expect.stringMatching(/ · 1 message$/),
    ]);
    expect(buttons('.ola-session-open')).toHaveLength(1);
  });

  it('says when the project has no saved sessions', async () => {
    const { controller, texts } = await openAssistant();
    await controller.showSessions();
    expect(texts('.ola-sessions-empty')).toEqual(['No saved sessions in this project yet.']);
  });

  it('opens a session, shows its conversation and closes the list', async () => {
    const { controller, texts, click, window } = await openAssistant(older, latest);
    expect(texts('.ola-user')).toEqual(['Fix the table.']);
    await controller.showSessions();
    click('button.ola-session-open');
    await vi.waitFor(() => {
      expect(texts('.ola-user')).toEqual(['Explain the intro.']);
    });
    expect(window.document.querySelector('.ola-sessions.is-open')).toBeNull();
    expect(texts('.ola-context')).toEqual(['Context 0 / 98.3k']);
  });

  it('deletes a session only after confirmation and refreshes the list', async () => {
    const { controller, sessions, texts, click } = await openAssistant(older, latest);
    await controller.showSessions();
    click('.ola-session:not(.is-current) .ola-session-delete');
    expect(texts('.ola-session-question')).toEqual(['Delete this session?']);
    click('.ola-session-cancel-delete');
    expect(texts('.ola-session-question')).toEqual([]);
    click('.ola-session:not(.is-current) .ola-session-delete');
    click('.ola-session-confirm-delete');
    await vi.waitFor(() => {
      expect(texts('.ola-session-title')).toEqual(['Session latest']);
    });
    expect(sessions.stored.has('older')).toBe(false);
    expect(texts('.ola-user')).toEqual(['Fix the table.']);
  });

  it('shows a new chat after deleting the current session', async () => {
    const { controller, texts, click } = await openAssistant(older, latest);
    await controller.showSessions();
    click('.ola-session.is-current .ola-session-delete');
    click('.ola-session-confirm-delete');
    await vi.waitFor(() => {
      expect(texts('.ola-session-title')).toEqual(['Session older']);
    });
    expect(texts('.ola-msg')).toEqual([expect.stringContaining('Ready to help')]);
    expect(texts('.ola-session.is-current')).toEqual([]);
  });

  it('lists unreadable sessions so they can be deleted', async () => {
    const { controller, sessions, texts, click } = await openAssistant(latest);
    sessions.unreadableIds = ['broken'];
    await controller.showSessions();
    expect(texts('.ola-session.is-unreadable .ola-session-title')).toEqual(['Unreadable session']);
    click('.ola-session.is-unreadable .ola-session-delete');
    click('.ola-session-confirm-delete');
    await vi.waitFor(() => {
      expect(texts('.ola-session.is-unreadable')).toEqual([]);
    });
  });

  it('disables the session actions while an operation runs', async () => {
    const { controller, project, changeId, buttons } = await proposeBibEdit();
    await controller.showSessions();
    const compiled = Promise.withResolvers<readonly CompileDiagnostic[]>();
    project.willCompile(new PendingStep(() => compiled.promise));
    const applying = controller.apply(changeId, null);
    expect(buttons('.ola-session-btn').every((button) => button.disabled)).toBe(true);
    compiled.resolve([]);
    await applying;
    expect(buttons('.ola-session-btn').some((button) => button.disabled)).toBe(false);
  });

  it('reports a refused switch while an operation runs', async () => {
    const { controller, project, changeId, texts } = await proposeBibEdit();
    const compiled = Promise.withResolvers<readonly CompileDiagnostic[]>();
    project.willCompile(new PendingStep(() => compiled.promise));
    const applying = controller.apply(changeId, null);
    await controller.openSession('session-1');
    expect(texts('.ola-error')).toEqual([
      'Error: The assistant is still working on the previous request.',
    ]);
    compiled.resolve([]);
    await applying;
  });
});
