import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_FILE_TEXTS, FIXTURE_ROOT_FOLDER } from '../support/fake-overleaf';
import { readStoredSessions, storeRawSession } from '../support/session-store';
import { TestFixtureError } from '../support/test-errors';
import {
  PAGE_WAIT,
  closeBrowsers,
  element,
  button,
  typeCommand,
  type ProjectSnapshot,
  start,
  signIn,
  reply,
  greetingReply,
  BOLD_EXPERIMENT,
  boldExperimentEdit,
} from '../support/assistant-page';

afterEach(closeBrowsers);

describe('assistant sessions', () => {
  const FIRST = 'What is this document about?';
  const SECOND = 'Make the word experiment bold.';
  const firstAnswer = reply('ACTION: answer', 'TEXT:', 'It describes an experiment.');

  async function twoSessions(sessions = new IDBFactory()) {
    const assistant = await start({ replies: [firstAnswer, boldExperimentEdit], sessions });
    await assistant.send(FIRST);
    await assistant.click('.ola-new-chat', () => {
      expect(assistant.messages()).toEqual([expect.stringContaining('Ready to help')]);
    });
    await assistant.send(SECOND);
    return assistant;
  }

  it('lists the sessions of the project newest first and switches between them', async () => {
    const { doc, showSessions, click, texts, messages, preview } = await twoSessions();
    expect(preview()).toEqual([BOLD_EXPERIMENT]);
    await showSessions();
    expect(texts('.ola-session-title')).toEqual([SECOND, FIRST]);
    expect(texts('.ola-session.is-current .ola-session-title')).toEqual([SECOND]);
    expect(texts('.ola-session-meta')).toEqual([
      expect.stringMatching(/ · 2 messages$/),
      expect.stringMatching(/ · 2 messages$/),
    ]);
    await click('button.ola-session-open', () => {
      expect(messages()).toEqual([FIRST, expect.stringContaining('It describes an experiment.')]);
    });
    expect(doc.querySelector('.ola-sessions.is-open')).toBeNull();
    expect(preview()).toEqual([]);
    await showSessions();
    expect(texts('.ola-session.is-current .ola-session-title')).toEqual([FIRST]);
    await click('button.ola-session-open', () => {
      expect(texts('.ola-user')).toEqual([SECOND]);
    });
    expect(texts('.ola-ai.is-discarded .ola-result-status')).toEqual(['Discarded']);
    expect(texts('.ola-apply')).toEqual([]);
  });

  it('keeps the sessions over a reload and deletes one after confirmation', async () => {
    const { sessions } = await twoSessions();
    const reloaded = await start({ sessions });
    expect(reloaded.texts('.ola-user')).toEqual([SECOND]);
    await reloaded.showSessions();
    expect(reloaded.texts('.ola-session-title')).toEqual([SECOND, FIRST]);
    button(reloaded.doc, '.ola-session:not(.is-current) .ola-session-delete').click();
    expect(reloaded.texts('.ola-session-question')).toEqual(['Delete this session?']);
    await reloaded.click('.ola-session-confirm-delete', () => {
      expect(reloaded.texts('.ola-session-title')).toEqual([SECOND]);
    });
    expect(reloaded.texts('.ola-user')).toEqual([SECOND]);
    expect(await readStoredSessions(sessions)).toEqual([
      expect.objectContaining({ title: SECOND }),
    ]);
  });

  it('starts a new chat when the current session is deleted', async () => {
    const { doc, showSessions, click, texts, messages, preview } = await twoSessions();
    await showSessions();
    button(element(doc, '.ola-session.is-current'), '.ola-session-delete').click();
    await click('.ola-session-confirm-delete', () => {
      expect(texts('.ola-session-title')).toEqual([FIRST]);
    });
    expect(messages()).toEqual([expect.stringContaining('Ready to help')]);
    expect(preview()).toEqual([]);
  });

  it('never shows the sessions of another project or user', async () => {
    const { sessions } = await twoSessions();
    const otherProject = await start({ sessions, prepare: signIn('user-1', 'project-2') });
    expect(otherProject.messages()).toEqual([expect.stringContaining('Ready to help')]);
    await otherProject.showSessions();
    expect(otherProject.texts('.ola-sessions-empty')).toEqual([
      'No saved sessions in this project yet.',
    ]);
    const otherUser = await start({ sessions, prepare: signIn('user-2', 'project-1') });
    await otherUser.showSessions();
    expect(otherUser.texts('.ola-session')).toEqual([]);
    const owner = await start({ sessions });
    await owner.showSessions();
    expect(owner.texts('.ola-session-title')).toEqual([SECOND, FIRST]);
  });

  it('lists an unreadable session and deletes it', async () => {
    const { doc, sessions, showSessions, click, texts } = await twoSessions();
    await storeRawSession(sessions, { userId: 'user-1', projectId: 'project-1', id: 'broken' });
    await showSessions();
    expect(texts('.ola-session.is-unreadable .ola-session-title')).toEqual(['Unreadable session']);
    button(doc, '.ola-session.is-unreadable .ola-session-delete').click();
    await click('.ola-session-confirm-delete', () => {
      expect(texts('.ola-session.is-unreadable')).toEqual([]);
    });
    expect(texts('.ola-session-title')).toEqual([SECOND, FIRST]);
  });

  it('closes the session list for a request and locks its actions while it runs', async () => {
    const { doc, ollama, showSessions, click, texts, messages } = await twoSessions();
    ollama.reply({ hang: true });
    await showSessions();
    typeCommand(doc, 'And the conclusion?');
    button(doc, '.ola-send').click();
    await vi.waitFor(() => {
      expect(ollama.prompts).toHaveLength(3);
    }, PAGE_WAIT);
    expect(doc.querySelector('.ola-sessions.is-open')).toBeNull();
    await showSessions();
    const actions = Array.from(doc.querySelectorAll<HTMLButtonElement>('.ola-session-btn'));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action.disabled)).toBe(true);
    await click('.ola-new-chat', () => {
      expect(messages()).toEqual([expect.stringContaining('Ready to help')]);
    });
    expect(texts('.ola-error')).toEqual([]);
  });
});

describe('assistant session exchange', () => {
  const BOLD_REQUEST = 'Make the word experiment bold.';
  const REQUEST = 'What is this document about?';
  const ANSWER = 'It describes an experiment.';
  const answerReply = reply('ACTION: answer', 'TEXT:', ANSWER);

  function reloadedWith(path: string, text: string): ProjectSnapshot {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const sessionsFolder = {
      _id: 'folder-sessions',
      name: 'hans-sessions',
      docs: [],
      fileRefs: [{ _id: 'file-export', name }],
      folders: [],
    };
    return {
      rootFolder: {
        ...FIXTURE_ROOT_FOLDER,
        folders: [...FIXTURE_ROOT_FOLDER.folders, sessionsFolder],
      },
      fileTexts: new Map([...FIXTURE_FILE_TEXTS, ['file-export', text]]),
    };
  }

  async function exportAnsweredSession(): Promise<{ path: string; text: string }> {
    const owner = await start({ replies: [boldExperimentEdit, answerReply] });
    await owner.send(BOLD_REQUEST);
    await owner.send(REQUEST);
    await owner.showSessions();
    await owner.click('.ola-session-export', () => {
      expect(owner.messages().at(-1)).toMatch(/^Exported to hans-sessions\/.+\.json\./);
    });
    expect(owner.messages()).toHaveLength(5);
    const [path, ...others] = owner.ide.server.paths().filter((p) => p.startsWith('hans-'));
    if (path === undefined || others.length) throw new TestFixtureError('one export expected');
    expect(path).toMatch(
      /^hans-sessions\/\d{4}-\d{2}-\d{2}-\d{6}-make-the-word-experiment-bold\.json$/,
    );
    return { path, text: owner.ide.server.textAt(path) };
  }

  it('exports a session that another user continues in their own browser', async () => {
    const { path, text } = await exportAnsweredSession();
    expect(JSON.parse(text)).toMatchObject({
      format: 'hans-session-export/1',
      projectId: 'project-1',
      exportedBy: 'user-1',
    });
    const collaboratorSessions = new IDBFactory();
    const collaborator = await start({
      replies: [greetingReply],
      sessions: collaboratorSessions,
      prepare: signIn('user-2', 'project-1'),
      project: reloadedWith(path, text),
    });
    await collaborator.showSessions();
    await collaborator.click('.ola-imports-toggle', () => {
      expect(collaborator.texts('.ola-import-row .ola-session-title')).toEqual([
        path.slice('hans-sessions/'.length),
      ]);
    });
    await collaborator.click('.ola-import', () => {
      expect(collaborator.messages().at(-1)).toBe(
        `Imported ${path} as a new session of yours; edits it left open were discarded.`,
      );
    });
    expect(collaborator.texts('.ola-user')).toEqual([BOLD_REQUEST, REQUEST]);
    expect(collaborator.texts('.ola-ai.is-discarded .ola-result-status')).toEqual(['Discarded']);
    expect(collaborator.preview()).toEqual([]);
    await collaborator.send('Thanks!');
    expect(collaborator.texts('.ola-user')).toEqual([BOLD_REQUEST, REQUEST, 'Thanks!']);
    await collaborator.showSessions();
    expect(collaborator.texts('.ola-session.is-current .ola-session-title')).toEqual([
      `Imported: ${BOLD_REQUEST}`,
    ]);
    expect(await readStoredSessions(collaboratorSessions)).toEqual([
      expect.objectContaining({ userId: 'user-2', projectId: 'project-1', messageCount: 7 }),
    ]);
    expect(collaborator.ide.server.textAt(path)).toBe(text);
    expect(collaborator.ide.server.requests.filter(({ method }) => method === 'POST')).toEqual([]);
  });

  it('refuses an export of another project with a clear error', async () => {
    const { path, text } = await exportAnsweredSession();
    const foreign = JSON.stringify({ ...JSON.parse(text), projectId: 'project-9' });
    const collaborator = await start({
      prepare: signIn('user-2', 'project-1'),
      project: reloadedWith(path, foreign),
    });
    await collaborator.showSessions();
    await collaborator.click('.ola-imports-toggle', () => {
      expect(collaborator.texts('.ola-import')).toEqual(['Import']);
    });
    await collaborator.click('.ola-import', () => {
      expect(collaborator.messages().at(-1)).toBe(
        'Error: This session was exported from another Overleaf project; import it in that project.',
      );
    });
    expect(collaborator.texts('.ola-sessions-empty')).toContain(
      'No saved sessions in this project yet.',
    );
    expect(collaborator.messages()).toEqual([
      expect.stringContaining('Ready to help'),
      expect.stringContaining('another Overleaf project'),
    ]);
  });

  it('tells the user when no session has been exported to the project yet', async () => {
    const assistant = await start({});
    await assistant.showSessions();
    await assistant.click('.ola-imports-toggle', () => {
      expect(assistant.texts('.ola-imports .ola-sessions-empty')).toEqual([
        'No sessions have been exported to hans-sessions/ yet.',
        'Sessions exported after this page loaded appear after reloading Overleaf.',
      ]);
    });
  });
});
