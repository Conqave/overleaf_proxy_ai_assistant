import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ApplyDocumentChange } from '../../../src/application/apply-document-change';
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
import { RejectDocumentChange } from '../../../src/application/reject-document-change';
import { ReviewAppliedChange } from '../../../src/application/review-applied-change';
import type { CompileDiagnostic } from '../../../src/domain/agent-transcript';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { InvariantViolation } from '../../../src/domain/errors';
import type { ConversationSession } from '../../../src/domain/session';
import { FileOpenTimeoutError } from '../../../src/ports/errors';
import { AssistantController } from '../../../src/presentation/assistant-controller';
import { AssistantView } from '../../../src/presentation/assistant-view';
import {
  FakeAgent,
  FakeEditor,
  FakeProject,
  FakeSummarizer,
  InMemorySessionRepository,
  PendingStep,
  sequentialIds,
  storedSession,
  ticking,
} from '../../support/fakes';
import { TestFixtureError } from '../../support/test-errors';

const BIB = ['@article{smith20}', '}'];

async function openAssistant(...stored: ConversationSession[]) {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const editor = new FakeEditor([]);
  const project = new FakeProject(
    editor,
    { 'main.tex': ['\\cite{knuth84}'], 'refs.bib': BIB },
    'main.tex',
  );
  const agent = new FakeAgent().will(
    { kind: 'tool', call: { tool: 'read_file', path: 'refs.bib' } },
    {
      kind: 'reply',
      reply: {
        kind: 'edit',
        path: 'refs.bib',
        command: createDocumentCommand({
          operation: 'insert_after',
          target: { lineNumber: 2, lineText: '}' },
          content: '@book{knuth84}',
          reason: 'Adds the missing entry.',
        }),
      },
    },
  );
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
  });
  const review = new ReviewAppliedChange({ project, conversation, handleRequest });
  const sessionDeps = { sessions, conversation, pendingChanges, editor, lock };
  const controller = new AssistantController({
    handleRequest,
    lock,
    applyChange: new ApplyDocumentChange({
      editor,
      project,
      pendingChanges,
      conversation,
      lock,
      review,
    }),
    rejectChange: new RejectDocumentChange({ editor, pendingChanges, lock }),
    restoreSession: new RestoreLatestSession(sessionDeps),
    startNewConversation: new StartNewConversation(sessionDeps),
    listSessions: new ListSessions(sessionDeps),
    openSession: new OpenSession(sessionDeps),
    deleteSession: new DeleteSession(sessionDeps),
    conversation,
  });
  await controller.attach(new AssistantView(window.document, controller));
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
    await controller.apply(changeId);
    expect(texts('.ola-context')).toEqual(['Context 3.0k / 98.3k']);
  });
});

describe('AssistantController apply', () => {
  it('reports the applied file and a clean compilation', async () => {
    const { controller, project, changeId, texts } = await proposeBibEdit();
    project.willCompile([]);
    await controller.apply(changeId);
    expect(texts('.ola-system')).toEqual([
      'Done. Inserted after the selected anchor in refs.bib.',
      'Compiled without errors.',
    ]);
  });

  it('keeps the applied proposal as a card marked applied', async () => {
    const { controller, project, changeId, texts } = await proposeBibEdit();
    project.willCompile([]);
    await controller.apply(changeId);
    expect(texts('.ola-ai.is-applied .ola-result-status')).toEqual(['Applied']);
    expect(texts('.ola-ai.is-applied .ola-result-meta')).toEqual(['refs.bib, anchor line 2: }']);
    expect(texts('.ola-apply')).toEqual([]);
  });
});

describe('AssistantController reject', () => {
  it('keeps the rejected proposal as a card marked rejected instead of a notice', async () => {
    const { controller, changeId, texts } = await proposeBibEdit();
    await controller.reject(changeId);
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
    await controller.apply(changeId);
    expect(texts('.ola-result-body').at(-1)).toBe('Add a closing brace.');
  });

  it('shows expected failures, marks the proposal not applied and continues', async () => {
    const { controller, editor, changeId, texts } = await proposeBibEdit();
    editor.lines[1] = 'Edited meanwhile.';
    await expect(controller.apply(changeId)).resolves.toBeUndefined();
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
    await controller.apply(changeId);
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
    await expect(controller.apply(changeId)).rejects.toBe(defect);
    expect(texts('.ola-error')).toEqual([
      'Unexpected internal error. Details are in the browser console.',
    ]);
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
  it('shows the busy state of the operation lock and ignores Enter until it ends', async () => {
    const { window, controller, project, changeId, texts } = await proposeBibEdit();
    const compiled = Promise.withResolvers<readonly CompileDiagnostic[]>();
    project.willCompile(new PendingStep(() => compiled.promise));
    const applying = controller.apply(changeId);
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
    const applying = controller.apply(changeId);
    expect(buttons('.ola-session-btn').every((button) => button.disabled)).toBe(true);
    compiled.resolve([]);
    await applying;
    expect(buttons('.ola-session-btn').some((button) => button.disabled)).toBe(false);
  });

  it('reports a refused switch while an operation runs', async () => {
    const { controller, project, changeId, texts } = await proposeBibEdit();
    const compiled = Promise.withResolvers<readonly CompileDiagnostic[]>();
    project.willCompile(new PendingStep(() => compiled.promise));
    const applying = controller.apply(changeId);
    await controller.openSession('session-1');
    expect(texts('.ola-error')).toEqual([
      'Error: The assistant is still working on the previous request.',
    ]);
    compiled.resolve([]);
    await applying;
  });
});
