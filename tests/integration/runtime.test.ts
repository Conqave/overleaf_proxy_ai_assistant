import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPILE_FIX_REQUEST } from '../../src/application/conversation-agent';
import { MAIN_AGENT_POLICY } from '../support/policies';
import type { ConversationMessage } from '../../src/domain/conversation';
import { IndexedDbSessionRepository } from '../../src/infrastructure/persistence/indexed-db-session-repository';
import { type Browser, openBrowser } from '../support/browser';
import {
  FAKE_AGENT_STEP_TIMEOUT_MS,
  FakeOllama,
  type OllamaPrompt,
  type OllamaReply,
  type ResponseReply,
} from '../support/fake-ollama';
import {
  EMPTY_LOG_ENTRIES,
  FIXTURE_DOC_ID,
  FIXTURE_DOCUMENT,
  FIXTURE_FILE_TEXTS,
  FIXTURE_ROOT_FOLDER,
  type FakeFolder,
  type FakeOverleafIde,
} from '../support/fake-overleaf';
import { itemAt, pointerEventOf } from '../support/guards';
import {
  eventStream,
  FakeMcpServer,
  messageEvent,
  readExaSearchFixture,
  resultOf,
} from '../support/fake-mcp-server';
import { readStoredSessions, storeRawSession } from '../support/session-store';
import { TestFixtureError } from '../support/test-errors';

const BUNDLE = readFileSync(
  new URL('../../dist/overleaf-ai-assistant.js', import.meta.url),
  'utf8',
);
const PAGE_WAIT = { timeout: 10_000 };
const PAST_OVERLEAF_DEADLINES_MS = 5 * 60_000;
const REFS_DOC_ID = 'doc-refs';
const REFS_TEXT = '@book{knuth84,\n  title = {The TeXbook}\n}';
const SMITH_ENTRY = '@article{smith20,\n  title = {Smith}\n}';

const UNUSED_CONTEXT = 'Context 0 / 98.3k';

const browsers: Browser[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const browser of browsers.splice(0)) {
    browser.close();
    expect(browser.pageErrors).toEqual([]);
    if (!browser.expectsConsoleErrors) expect(browser.consoleErrors).toEqual([]);
  }
});

function open(ollama: FakeOllama, sessions: IDBFactory = new IDBFactory()): Browser {
  const browser = openBrowser(ollama, sessions);
  browsers.push(browser);
  return browser;
}

async function waitForStartupFailure(browser: Browser): Promise<void> {
  browser.expectsConsoleErrors = true;
  await vi.waitFor(() => {
    expect(browser.consoleErrors).toEqual([
      expect.stringContaining('[overleaf-ai-assistant] not started'),
    ]);
  }, PAGE_WAIT);
}

async function waitForAssistant(browser: Browser): Promise<void> {
  await vi.waitFor(() => {
    expect(browser.document.querySelectorAll('#ola-root .ola-msg').length).toBeGreaterThan(0);
  }, PAGE_WAIT);
}

function element(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) throw new TestFixtureError(`the page shows no ${selector}`);
  return found;
}

function button(root: ParentNode, selector: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(selector);
  if (found === null) throw new TestFixtureError(`the page shows no ${selector} button`);
  return found;
}

function commandInput(root: ParentNode): HTMLTextAreaElement {
  const found = root.querySelector<HTMLTextAreaElement>('.ola-textarea');
  if (found === null) throw new TestFixtureError('the page shows no command input');
  return found;
}

function typeCommand(doc: Document, text: string): void {
  const input = commandInput(doc);
  const window = doc.defaultView;
  if (window === null) throw new TestFixtureError('the page has no window');
  input.value = text;
  input.dispatchEvent(new window.Event('input'));
}

function session(browser: Browser, ide: FakeOverleafIde, sessions: IDBFactory) {
  const doc = browser.document;
  const texts = (selector: string) =>
    Array.from(doc.querySelectorAll(selector)).map((node) => node.textContent);
  const messages = () => texts('.ola-msg');
  const isIdle = () => !element(doc, '#ola-root').classList.contains('is-busy');
  const send = async (request: string) => {
    const before = messages().length;
    typeCommand(doc, request);
    button(doc, '.ola-send').click();
    await vi.waitFor(() => {
      expect(messages().length).toBeGreaterThan(before);
      expect(isIdle()).toBe(true);
    }, PAGE_WAIT);
  };
  const click = async (selector: string, done: () => void) => {
    button(doc, selector).click();
    await vi.waitFor(() => {
      done();
      expect(isIdle()).toBe(true);
    }, PAGE_WAIT);
  };
  const showSessions = async () => {
    button(doc, '.ola-sessions-toggle').click();
    await vi.waitFor(() => {
      element(doc, '.ola-sessions.is-open .ola-sessions-title');
    }, PAGE_WAIT);
  };
  const editorText = () => ide.editor.state.doc.toString();
  const preview = () => texts('.ola-preview-added');
  return {
    browser,
    sessions,
    doc,
    ide,
    ollama: browser.ollama,
    send,
    click,
    showSessions,
    texts,
    messages,
    editorText,
    preview,
    isIdle,
  };
}

type Session = ReturnType<typeof session>;

function isCompiling({ texts }: Session): () => void {
  return () => {
    expect(texts('.ola-status')).toEqual(['Hans is compiling the project']);
  };
}

async function sendPastTimeouts(
  { doc, isIdle }: Session,
  request: string,
  waiting: () => void,
  waitedMs: number,
): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  typeCommand(doc, request);
  button(doc, '.ola-send').click();
  await vi.waitFor(waiting, PAGE_WAIT);
  await vi.advanceTimersByTimeAsync(waitedMs);
  vi.useRealTimers();
  await vi.waitFor(() => {
    expect(isIdle()).toBe(true);
  }, PAGE_WAIT);
}

interface StartOptions {
  readonly replies?: readonly OllamaReply[];
  readonly sessions?: IDBFactory;
  readonly prepare?: (browser: Browser) => void;
  readonly project?: ProjectSnapshot;
}

interface ProjectSnapshot {
  readonly rootFolder: FakeFolder;
  readonly fileTexts: ReadonlyMap<string, string>;
}

async function start({
  replies = [],
  sessions = new IDBFactory(),
  prepare = () => undefined,
  project = { rootFolder: FIXTURE_ROOT_FOLDER, fileTexts: FIXTURE_FILE_TEXTS },
}: StartOptions) {
  const browser = open(new FakeOllama().reply(...replies), sessions);
  prepare(browser);
  browser.inject(BUNDLE);
  const ide = browser.loadOverleaf(project.rootFolder, project.fileTexts);
  await waitForAssistant(browser);
  return session(browser, ide, sessions);
}

function signIn(userId: string, projectId: string): (browser: Browser) => void {
  return (browser) => {
    element(browser.document, 'meta[name="ol-user_id"]').setAttribute('content', userId);
    element(browser.document, 'meta[name="ol-project_id"]').setAttribute('content', projectId);
  };
}

function denyStorage(browser: Browser): void {
  const { DOMException } = browser.window;
  Object.assign(browser.window, {
    indexedDB: {
      open: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    },
  });
}

const reply = (...lines: readonly string[]): ResponseReply => ({ response: lines.join('\n') });

const GREETING_ANSWER = 'Hi! What should I change?';
const greetingReply = reply('ACTION: answer', 'TEXT:', GREETING_ANSWER);

const editReply = (fields: Record<string, string>, content: string): ResponseReply =>
  reply(
    'ACTION: edit',
    ...Object.entries(fields).map(([name, value]) => `${name}: ${value}`),
    'CONTENT:',
    content,
  );

const EXPERIMENT_LINE = 'This report describes the experiment.';
const BOLD_EXPERIMENT = 'This report describes the \\textbf{experiment}.';
const boldExperimentEdit = editReply(
  { PATH: 'main.tex', OPERATION: 'replace', LINE: '4', LINE_TEXT: EXPERIMENT_LINE },
  BOLD_EXPERIMENT,
);

const smithEntryEdit = editReply(
  { PATH: 'refs.bib', OPERATION: 'insert_after', LINE: '3', LINE_TEXT: '}' },
  SMITH_ENTRY,
);

function contextText(call: OllamaPrompt): string {
  return `Context ${(call.promptTokens / 1000).toFixed(1)}k / 98.3k`;
}

function undefinedCommandLog(ide: FakeOverleafIde): () => unknown {
  return () => {
    const line = ide
      .textOf(FIXTURE_DOC_ID)
      .split('\n')
      .findIndex((text) => text.includes('\\textbff'));
    if (line === -1) return EMPTY_LOG_ENTRIES;
    const error = { message: 'Undefined control sequence.', file: './main.tex', line: line + 1 };
    return { ...EMPTY_LOG_ENTRIES, errors: [error], all: [error] };
  };
}

describe('assistant startup', () => {
  it('opens with badge, panel and welcome message and warms the model', async () => {
    const { doc, messages, ollama } = await start({});
    await vi.waitFor(() => {
      expect(ollama.loads).toHaveLength(1);
    }, PAGE_WAIT);
    expect(element(doc, '.ola-badge').textContent).toBe('Hans');
    expect(element(doc, '.ola-head').textContent).toContain('Hans AI Assistant');
    expect(element(doc, '.ola-context').textContent).toBe(UNUSED_CONTEXT);
    expect(messages()).toEqual([expect.stringContaining('Ready to help with this document')]);
    button(doc, '.ola-badge').click();
    expect(element(doc, '#ola-root').classList.contains('is-collapsed')).toBe(true);
  });

  it('is injected only once and keeps one preview in a reopened editor', async () => {
    const { browser, doc, ide, ollama, send, preview } = await start({
      replies: [boldExperimentEdit],
    });
    browser.inject(BUNDLE);
    ide.reopenEditor();
    await vi.waitFor(() => {
      expect(ollama.loads).toHaveLength(1);
    }, PAGE_WAIT);
    await send('Make the word experiment bold.');
    expect(doc.querySelectorAll('#ola-root')).toHaveLength(1);
    expect(doc.querySelectorAll('#ola-style')).toHaveLength(1);
    expect(preview()).toEqual([BOLD_EXPERIMENT]);
  });

  it('waits for the editor to appear', async () => {
    const browser = open(new FakeOllama());
    browser.inject(BUNDLE);
    expect(browser.document.getElementById('ola-root')).toBeNull();
    browser.loadOverleaf();
    await waitForAssistant(browser);
  });

  it('does not start with invalid configuration', async () => {
    const ollama = new FakeOllama();
    ollama.config = { model: '' };
    const browser = open(ollama);
    browser.inject(BUNDLE);
    browser.loadOverleaf();
    await waitForStartupFailure(browser);
    expect(browser.consoleErrors[0]).toContain('Invalid assistant configuration');
    expect(browser.document.getElementById('ola-root')).toBeNull();
  });

  it('does not start on a page that names no user', async () => {
    const browser = open(new FakeOllama());
    browser.document.querySelector('meta[name="ol-user_id"]')?.remove();
    browser.inject(BUNDLE);
    browser.loadOverleaf();
    await waitForStartupFailure(browser);
    expect(browser.document.getElementById('ola-root')).toBeNull();
    expect(browser.ollama.loads).toHaveLength(0);
    expect(browser.ollama.prompts).toHaveLength(0);
  });

  it('does not start when the editor opens without the Overleaf store', async () => {
    const browser = open(new FakeOllama());
    Object.defineProperty(browser.window, 'overleaf', {
      configurable: true,
      get: () => undefined,
      set: () => undefined,
    });
    browser.inject(BUNDLE);
    browser.loadOverleaf();
    browser.expectsConsoleErrors = true;
    await vi.waitFor(() => {
      expect(browser.consoleErrors).toContainEqual(
        expect.stringMatching(/not started.*window\.overleaf\.unstable\.store/),
      );
    }, PAGE_WAIT);
    expect(browser.document.getElementById('ola-root')).toBeNull();
  });
});

const PANEL_SIZE_KEY = 'ola-panel-size';

function panelSize(doc: Document): { width: string; height: string } {
  const panel = element(doc, '.ola-panel');
  return {
    width: panel.style.getPropertyValue('--ola-panel-width'),
    height: panel.style.getPropertyValue('--ola-panel-height'),
  };
}

function dragCorner({ browser, doc }: Session, from: number, to: number): void {
  const handle = element(doc, '.ola-resize-handle');
  const PagePointerEvent = pointerEventOf(browser.window);
  for (const [type, offset] of [
    ['pointerdown', from],
    ['pointermove', (from + to) / 2],
    ['pointermove', to],
    ['pointerup', to],
  ] as const) {
    handle.dispatchEvent(
      new PagePointerEvent(type, {
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: offset,
        clientY: offset,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
}

function typingBubble(doc: Document): HTMLElement {
  return element(doc, '.ola-chat > .ola-typing:last-child');
}

describe('assistant panel', () => {
  it('resizes by dragging its corner and keeps the size over a reload', async () => {
    const opened = await start({});
    expect(panelSize(opened.doc)).toEqual({ width: '380px', height: '640px' });
    dragCorner(opened, 500, 420);
    expect(panelSize(opened.doc)).toEqual({ width: '460px', height: '672px' });
    const remembered = opened.browser.window.localStorage.getItem(PANEL_SIZE_KEY);
    expect(remembered).toBe('{"width":460,"height":672}');
    const reloaded = await start({
      prepare: (browser) => {
        browser.window.localStorage.setItem(PANEL_SIZE_KEY, String(remembered));
      },
    });
    expect(panelSize(reloaded.doc)).toEqual({ width: '460px', height: '672px' });
  });

  it('shows a typing bubble while Hans works and removes it when the work ends', async () => {
    const { doc, send, click, texts, messages, ollama } = await start({
      replies: [{ hang: true }],
    });
    expect(typingBubble(doc).hidden).toBe(true);
    typeCommand(doc, 'What is this document about?');
    button(doc, '.ola-send').click();
    await vi.waitFor(() => {
      expect(ollama.prompts).toHaveLength(1);
    }, PAGE_WAIT);
    expect(typingBubble(doc).hidden).toBe(false);
    expect(texts('.ola-typing .ola-status')).toEqual(['Hans is thinking']);
    await click('.ola-new-chat', () => {
      expect(typingBubble(doc).hidden).toBe(true);
    });
    ollama.reply(greetingReply);
    await send('hi');
    expect(messages().at(-1)).toContain(GREETING_ANSWER);
    expect(typingBubble(doc).hidden).toBe(true);
  });
});

describe('assistant conversation', () => {
  it('keeps Send disabled for a blank command and adds no error', async () => {
    const { browser, doc, messages, ollama } = await start({});
    expect(button(doc, '.ola-send').disabled).toBe(true);
    typeCommand(doc, '  \n ');
    expect(button(doc, '.ola-send').disabled).toBe(true);
    button(doc, '.ola-send').click();
    commandInput(doc).dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter' }));
    expect(messages()).toEqual([expect.stringContaining('Ready to help')]);
    expect(ollama.prompts).toHaveLength(0);
    typeCommand(doc, 'hello');
    expect(button(doc, '.ola-send').disabled).toBe(false);
  });

  it('sends a greeting to the model like any other message', async () => {
    const { send, messages, ollama, doc } = await start({ replies: [greetingReply] });
    await send('hello');
    expect(itemAt(ollama.prompts, 0, 'prompt').userMessage).toContain('User message:\nhello');
    expect(messages()).toEqual(['hello', expect.stringContaining(GREETING_ANSWER)]);
    expect(commandInput(doc).value).toBe('');
  });

  it('reloads the latest session and starts a new one that keeps it stored', async () => {
    const first = await start({ replies: [greetingReply] });
    await first.send('hi');
    const second = await start({ sessions: first.sessions });
    expect(second.messages()).toEqual(['hi', expect.stringContaining(GREETING_ANSWER)]);
    await second.click('.ola-new-chat', () => {
      expect(second.messages()).toEqual([expect.stringContaining('Ready to help')]);
    });
    expect(second.texts('.ola-context')).toEqual([UNUSED_CONTEXT]);
    expect(await readStoredSessions(first.sessions)).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        projectId: 'project-1',
        title: 'hi',
        messageCount: 2,
      }),
    ]);
  });

  it('reports a browser that denies session storage and stays usable', async () => {
    const { messages, send } = await start({ replies: [greetingReply], prepare: denyStorage });
    expect(messages()).toEqual([
      expect.stringContaining('Ready to help'),
      'Error: Could not open the saved sessions of this browser.',
    ]);
    await send('hi');
    expect(messages()).toEqual([
      'Error: Could not open the saved sessions of this browser.',
      'hi',
      expect.stringContaining(GREETING_ANSWER),
      'Could not open the saved sessions of this browser.',
    ]);
  });

  it('sends with Enter, not with Shift+Enter, and leaves page shortcuts alone', async () => {
    const { browser, doc, messages } = await start({ replies: [greetingReply] });
    const input = commandInput(doc);
    const { KeyboardEvent } = browser.window;
    input.value = 'hi';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    expect(messages()).toEqual([expect.stringContaining('Ready to help')]);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.waitFor(() => {
      expect(messages()).toEqual(['hi', expect.stringContaining(GREETING_ANSWER)]);
    }, PAGE_WAIT);
    input.value = 'hey';
    const inspect = new KeyboardEvent('keydown', {
      code: 'KeyC',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    browser.window.dispatchEvent(inspect);
    expect(inspect.defaultPrevented).toBe(false);
    expect(messages()).toHaveLength(2);
  });
});

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

  it('locks the session actions while a request runs', async () => {
    const { doc, ollama, showSessions, click, texts, messages } = await twoSessions();
    ollama.reply({ hang: true });
    await showSessions();
    typeCommand(doc, 'And the conclusion?');
    button(doc, '.ola-send').click();
    await vi.waitFor(() => {
      expect(ollama.prompts).toHaveLength(3);
    }, PAGE_WAIT);
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

describe('assistant agent', () => {
  it('answers from the open file and shows the context usage', async () => {
    const { send, click, texts, ollama } = await start({
      replies: [reply('ACTION: answer', 'TEXT:', 'It describes an experiment.')],
    });
    await send('What is this document about?');
    expect(texts('.ola-result-body').at(-1)).toBe('It describes an experiment.');
    const call = itemAt(ollama.prompts, 0, 'prompt');
    expect(call.instructions).toContain('ACTION: read_file');
    expect(call.userMessage).toContain(
      'Project files:\nmain.tex (open in the editor)\nrefs.bib\nfrog.jpg (binary)\nchapters/intro/intro.tex',
    );
    expect(call.userMessage).toContain('3: \\section{Introduction}');
    expect(texts('.ola-context')).toEqual([contextText(call)]);
    await click('.ola-new-chat', () => {
      expect(texts('.ola-context')).toEqual([UNUSED_CONTEXT]);
    });
  });

  it('colours the context indicator by how full the context window is', async () => {
    const answerWith = (promptTokens: number): ResponseReply => ({
      ...reply('ACTION: answer', 'TEXT:', 'Done.'),
      promptTokens,
    });
    const { send, doc, browser } = await start({
      replies: [answerWith(50_000), answerWith(60_000), answerWith(80_000)],
    });
    const indicator = () => element(doc, '.ola-context');
    const colour = () => browser.window.getComputedStyle(indicator()).color;
    expect(indicator().className).toBe('ola-context is-low');
    await send('first');
    expect(indicator().className).toBe('ola-context is-low');
    await send('second');
    expect(indicator().className).toBe('ola-context is-elevated');
    expect(colour()).toBe('rgb(241, 196, 15)');
    await send('third');
    expect(indicator().className).toBe('ola-context is-high');
    expect(colour()).toBe('rgb(255, 123, 107)');
  });

  it('searches every text file of the project', async () => {
    const { send, texts, ollama } = await start({
      replies: [
        reply('ACTION: search', 'QUERY: knuth'),
        reply('ACTION: answer', 'TEXT:', 'knuth84 is defined in refs.bib.'),
      ],
    });
    await send('Where is knuth84 defined?');
    expect(texts('.ola-result-body').at(-1)).toBe('knuth84 is defined in refs.bib.');
    expect(itemAt(ollama.prompts, 1, 'prompt').userMessage).toContain(
      'Result 1 (search "knuth"):\nrefs.bib:1: @book{knuth84,',
    );
  });

  it('shows answers and questions as Markdown and keeps the user text plain', async () => {
    const { doc, send, texts } = await start({
      replies: [
        reply(
          'ACTION: answer',
          'TEXT:',
          '## Steps',
          '- add `\\label{fig:a}`',
          '- see [docs](https://www.overleaf.com/learn)',
          '',
          '```latex',
          '\\begin{figure}',
          '\\end{figure}',
          '```',
          '<img src=x onerror="alert(1)">',
        ),
        reply('ACTION: question', 'QUESTION: Which **figure** do you mean?'),
      ],
    });
    await send('How do I add a **figure**?');
    const answer = element(doc, '.ola-ai .ola-markdown');
    expect(element(answer, 'h2').textContent).toBe('Steps');
    expect(texts('.ola-markdown li code')).toEqual(['\\label{fig:a}']);
    expect(element(answer, 'pre code').textContent).toBe('\\begin{figure}\n\\end{figure}\n');
    expect(element(answer, 'a').getAttribute('rel')).toBe('noopener noreferrer');
    expect(answer.querySelector('img')).toBe(null);
    expect(answer.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(texts('.ola-user')).toEqual(['How do I add a **figure**?']);
    await send('Add one.');
    expect(texts('.ola-markdown strong')).toEqual(['figure']);
  });

  it('shows the content of a proposal as plain text', async () => {
    const { send, texts, doc } = await start({
      replies: [
        editReply(
          {
            PATH: 'main.tex',
            OPERATION: 'replace',
            LINE: '4',
            LINE_TEXT: EXPERIMENT_LINE,
            REASON: 'Make **it** bold.',
          },
          '**This** report.',
        ),
      ],
    });
    await send('Make it bold.');
    expect(texts('.ola-result-reason')).toEqual(['Make **it** bold.']);
    expect(texts('.ola-result-body')).toEqual(['**This** report.']);
    expect(doc.querySelector('.ola-ai .ola-markdown, .ola-ai strong')).toBe(null);
  });

  it('reads another file, opens it and previews an edit of it', async () => {
    const { send, texts, ollama, ide, editorText, preview } = await start({
      replies: [reply('ACTION: read_file', 'PATH: refs.bib'), smithEntryEdit],
    });
    await send('Add the smith20 entry to the bibliography.');
    expect(itemAt(ollama.prompts, 1, 'prompt').userMessage).toContain(
      'Result 1 (read_file refs.bib):\n1: @book{knuth84,\n2:   title = {The TeXbook}\n3: }',
    );
    expect(ide.store.get('editor.open_doc_id')).toBe(REFS_DOC_ID);
    expect(editorText()).toBe(REFS_TEXT);
    expect(preview()).toEqual([SMITH_ENTRY.replaceAll('\n', '')]);
    expect(texts('.ola-result-meta').at(-1)).toBe('refs.bib, anchor line 3: }');
  });

  it('applies the edit of another file and compiles the project', async () => {
    const { send, click, texts, messages, ide, editorText, preview } = await start({
      replies: [reply('ACTION: read_file', 'PATH: refs.bib'), smithEntryEdit],
    });
    await send('Add the smith20 entry to the bibliography.');
    await click('.ola-apply', () => {
      expect(messages()).toEqual([
        'Add the smith20 entry to the bibliography.',
        expect.stringContaining('Proposed insertion'),
        'Done. Inserted after the selected anchor in refs.bib.',
        'Compiled without errors.',
      ]);
    });
    expect(editorText()).toBe(`${REFS_TEXT}\n${SMITH_ENTRY}`);
    expect(preview()).toEqual([]);
    expect(ide.compileCount).toBe(1);
    expect(texts('.ola-ai.is-applied .ola-result-status')).toEqual(['Applied']);
  });

  it('rejects the edit of another file, leaves it unchanged and keeps the decision', async () => {
    const { sessions, send, click, texts, ide, editorText, preview } = await start({
      replies: [reply('ACTION: read_file', 'PATH: refs.bib'), smithEntryEdit],
    });
    await send('Add the smith20 entry to the bibliography.');
    await click('.ola-reject', () => {
      expect(texts('.ola-ai.is-rejected .ola-result-status')).toEqual(['Rejected']);
    });
    expect(texts('.ola-system')).toEqual([]);
    expect(texts('.ola-apply')).toEqual([]);
    expect(editorText()).toBe(REFS_TEXT);
    expect(preview()).toEqual([]);
    expect(ide.compileCount).toBe(0);
    const reloaded = await start({ sessions });
    expect(reloaded.texts('.ola-ai.is-rejected .ola-result-status')).toEqual(['Rejected']);
    expect(reloaded.texts('.ola-ai.is-rejected .ola-result-meta')).toEqual([
      'refs.bib, anchor line 3: }',
    ]);
  });

  it('proposes edits of two files as one change, previews each file and applies them', async () => {
    const twoFiles = reply(
      'ACTION: edit',
      'PATH: main.tex',
      'OPERATION: replace',
      'LINE: 4',
      `LINE_TEXT: ${EXPERIMENT_LINE}`,
      'CONTENT:',
      BOLD_EXPERIMENT,
      'PATH: refs.bib',
      'OPERATION: insert_after',
      'LINE: 3',
      'LINE_TEXT: }',
      'CONTENT:',
      SMITH_ENTRY,
    );
    const { doc, send, click, texts, ide, editorText, preview } = await start({
      replies: [reply('ACTION: read_file', 'PATH: refs.bib'), twoFiles],
    });
    await send('Cite smith20 in bold and add its entry.');
    expect(texts('.ola-ai .ola-result-title')).toEqual(['Proposed changes: 2 edits in 2 files']);
    expect(texts('.ola-change-path')).toEqual(['main.tex', 'refs.bib']);
    expect(ide.store.get('editor.open_doc_id')).toBe(FIXTURE_DOC_ID);
    expect(preview()).toEqual([BOLD_EXPERIMENT]);
    const showBib = doc.querySelectorAll<HTMLButtonElement>('.ola-preview-file')[1];
    if (showBib === undefined) throw new TestFixtureError('refs.bib has no Show button');
    showBib.click();
    await vi.waitFor(() => {
      expect(preview()).toEqual([SMITH_ENTRY.replaceAll('\n', '')]);
    }, PAGE_WAIT);
    expect(ide.store.get('editor.open_doc_id')).toBe(REFS_DOC_ID);
    await click('.ola-apply', () => {
      expect(texts('.ola-system')).toEqual([
        'Done. Applied 2 edits in main.tex, refs.bib.',
        'Compiled without errors.',
      ]);
    });
    expect(editorText()).toBe(`${REFS_TEXT}\n${SMITH_ENTRY}`);
    expect(ide.textOf(FIXTURE_DOC_ID).split('\n')[3]).toBe(BOLD_EXPERIMENT);
    expect(ide.compileCount).toBe(1);
    expect(texts('.ola-ai.is-applied > .ola-result-status')).toEqual(['Applied']);
  });

  it('undoes a turn, keeps it undone over a reload and tells the model', async () => {
    const { sessions, send, click, texts, ollama, ide, editorText } = await start({
      replies: [boldExperimentEdit, reply('ACTION: answer', 'TEXT:', 'It was undone.')],
    });
    await send('Make the word experiment bold.');
    await click('.ola-apply', () => {
      expect(texts('.ola-system')).toContain('Compiled without errors.');
    });
    expect(editorText().split('\n')[3]).toBe(BOLD_EXPERIMENT);
    await click('.ola-undo', () => {
      expect(texts('.ola-undo-notice')).toEqual([
        'Undone in main.tex: the edits of this change were taken back; other edits stay.',
      ]);
    });
    expect(editorText().split('\n')[3]).toBe(EXPERIMENT_LINE);
    expect(texts('.ola-ai.is-undone > .ola-result-status')).toEqual(['Undone']);
    expect(texts('.ola-undo')).toEqual([]);
    expect(ide.compileCount).toBe(2);
    expect(texts('.ola-system').at(-1)).toBe('Compiled without errors.');
    await send('Is the word still bold?');
    expect(itemAt(ollama.prompts, 1, 'prompt').userMessage).toContain(
      '[editor] The user undid the applied edits of an earlier change in main.tex',
    );
    const reloaded = await start({ sessions });
    expect(reloaded.texts('.ola-undo-notice')).toEqual([
      'Undone in main.tex: the edits of this change were taken back; other edits stay.',
    ]);
    expect(reloaded.texts('.ola-undo')).toEqual([]);
  });

  it('applies and rejects single edits of a change and compiles after the last one', async () => {
    const twoPlaces = reply(
      'ACTION: edit',
      'PATH: main.tex',
      'OPERATION: replace',
      'LINE: 4',
      `LINE_TEXT: ${EXPERIMENT_LINE}`,
      'CONTENT:',
      BOLD_EXPERIMENT,
      'PATH: main.tex',
      'OPERATION: insert_after',
      'LINE: 6',
      'LINE_TEXT: The results are shown below.',
      'CONTENT:',
      'They look fine.',
    );
    const { send, click, texts, ide, editorText, preview } = await start({ replies: [twoPlaces] });
    await send('Bold the experiment and comment the results.');
    expect(preview()).toEqual([BOLD_EXPERIMENT, 'They look fine.']);
    await click('.ola-reject-edit', () => {
      expect(texts('.ola-ai > .ola-result-status')).toEqual(['1 rejected · 1 open']);
    });
    expect(preview()).toEqual(['They look fine.']);
    await click('.ola-apply-edit', () => {
      expect(texts('.ola-system')).toContain('Compiled without errors.');
    });
    expect(editorText().split('\n').slice(3, 7)).toEqual([
      EXPERIMENT_LINE,
      '\\section{Results}',
      'The results are shown below.',
      'They look fine.',
    ]);
    expect(ide.compileCount).toBe(1);
    expect(texts('.ola-ai > .ola-result-status')).toEqual(['1 applied · 1 rejected']);
  });

  it.each([
    ['still produces a PDF', 'pdf'],
    ['stops it before any PDF', 'pdf-unless-errors'],
  ] as const)(
    'asks for a fix when the applied change %s and applies it',
    async (_name, outcome) => {
      const broken = 'This report describes the \\textbff{experiment}.';
      const fixed = 'This report describes the \\textbf{experiment}.';
      const lineFour = { PATH: 'main.tex', OPERATION: 'replace', LINE: '4' };
      const { sessions, send, click, texts, messages, ollama, ide, editorText } = await start({
        replies: [
          editReply({ ...lineFour, LINE_TEXT: EXPERIMENT_LINE }, broken),
          editReply({ ...lineFour, LINE_TEXT: broken }, fixed),
        ],
      });
      ide.compileLog = undefinedCommandLog(ide);
      ide.compileOutcome = outcome;
      await send('Make the word experiment bold.');
      await click('.ola-apply', () => {
        expect(texts('.ola-result-body').at(-1)).toBe(fixed);
      });
      expect(messages()).toEqual([
        'Make the word experiment bold.',
        expect.stringContaining('Proposed replacement'),
        'Done. Line replaced in main.tex.',
        COMPILE_FIX_REQUEST,
        expect.stringContaining('Proposed replacement'),
      ]);
      expect(texts('.ola-system')).toContain(COMPILE_FIX_REQUEST);
      expect(texts('.ola-user')).toEqual(['Make the word experiment bold.']);
      const fixPrompt = itemAt(ollama.prompts, 1, 'prompt').userMessage;
      expect(fixPrompt).toContain(
        `System request (sent by the editor, not typed by the user):\n${COMPILE_FIX_REQUEST}\n\nThe user's last message, whose language your texts use:\nMake the word experiment bold.`,
      );
      expect(fixPrompt).toContain(
        'Compile result after the applied change:\nerror main.tex:4: Undefined control sequence.',
      );
      await click('.ola-apply', () => {
        expect(texts('.ola-system').at(-1)).toBe('Compiled without errors.');
      });
      expect(editorText().split('\n')[3]).toBe(fixed);
      expect(ide.compileCount).toBe(2);
      const reloaded = await start({ sessions });
      expect(reloaded.texts('.ola-system')).toEqual(texts('.ola-system'));
      expect(reloaded.texts('.ola-system')).toEqual([
        'Done. Line replaced in main.tex.',
        COMPILE_FIX_REQUEST,
        'Done. Line replaced in main.tex.',
        'Compiled without errors.',
      ]);
      expect(reloaded.texts('.ola-user')).toEqual(['Make the word experiment bold.']);
    },
  );

  it.each([
    ['an HTTP error', [{ status: 500 }], 'Ollama answered HTTP 500'],
    [
      'two replies in an unknown format',
      [reply('hello'), reply('ACTION: dance')],
      'The assistant replied in an unexpected format',
    ],
  ])('reports %s and stays usable', async (_name, replies: OllamaReply[], error) => {
    const { send, texts, messages, ollama } = await start({ replies });
    await send('What is this document about?');
    expect(texts('.ola-error')).toEqual([expect.stringContaining(error)]);
    expect(texts('.ola-status')).toEqual(['']);
    ollama.reply(greetingReply);
    await send('hi');
    expect(messages().at(-1)).toContain(GREETING_ANSWER);
  });

  it('reports a model that does not answer in time and stays usable', async () => {
    const assistant = await start({ replies: [{ hang: true }] });
    const { send, texts, messages, ollama } = assistant;
    await sendPastTimeouts(
      assistant,
      'What is this document about?',
      () => {
        expect(ollama.prompts).toHaveLength(1);
      },
      FAKE_AGENT_STEP_TIMEOUT_MS,
    );
    expect(texts('.ola-error')).toEqual([
      expect.stringContaining('Ollama did not finish this step within 10 seconds'),
    ]);
    ollama.reply(greetingReply);
    await send('hi');
    expect(messages().at(-1)).toContain(GREETING_ANSWER);
  });
});

async function storedConversation(messages: ConversationMessage[]): Promise<IDBFactory> {
  const sessions = new IDBFactory();
  const repository = new IndexedDbSessionRepository(
    { indexedDB: sessions },
    { userId: 'user-1', projectId: 'project-1' },
  );
  await repository.save({
    id: 'stored',
    title: 'Stored',
    createdAt: 1,
    updatedAt: 2,
    messages,
    imported: null,
    contextUsage: null,
  });
  return sessions;
}

const LONG_HISTORY = Array.from({ length: 50 }, (_, turn): ConversationMessage[] => [
  { id: `u-${String(turn)}`, role: 'user', text: `Question ${String(turn)} about tables?` },
  {
    id: `a-${String(turn)}`,
    role: 'assistant',
    kind: 'explanation',
    text: `Answer ${String(turn)}: ${'Use booktabs rules and caption every table. '.repeat(70)}`,
  },
]).flat();

const SUMMARY_NOTE = '## Goal\nKeep the tables of the report consistent.';

describe('assistant subagent', () => {
  const TASK = 'Check that every \\cite key of main.tex is defined in refs.bib, with path:line';
  const FINDINGS = '- main.tex:108 `\\cite{greenwade93}`: key missing from refs.bib';

  it('shows the subagent at work and its findings collapsed in the chat, also after a reload', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessions = new IDBFactory();
    const { doc, texts, ollama, isIdle } = await start({
      sessions,
      replies: [
        reply('ACTION: delegate', `TASK: ${TASK}`, 'FILES: main.tex, refs.bib'),
        { response: reply('ACTION: read_file', 'PATH: refs.bib').response, heldUntil: held },
        reply('ACTION: search', 'QUERY: \\cite{', 'PATH: main.tex'),
        reply('ACTION: answer', 'TEXT:', FINDINGS),
        reply('ACTION: answer', 'TEXT:', 'The key greenwade93 is not defined in refs.bib.'),
      ],
    });
    typeCommand(doc, 'are all my citations defined?');
    button(doc, '.ola-send').click();
    await vi.waitFor(() => {
      expect(texts('.ola-status')).toEqual(['Hans: subagent reviewing 2 files…']);
    }, PAGE_WAIT);
    release();
    await vi.waitFor(() => {
      expect(isIdle()).toBe(true);
    }, PAGE_WAIT);
    const card = element(doc, 'details.ola-delegation');
    expect(card.hasAttribute('open')).toBe(false);
    expect(texts('.ola-delegation-title')).toEqual([`Subagent result: ${TASK}`]);
    expect(texts('.ola-delegation-body li')).toEqual([
      'main.tex:108 \\cite{greenwade93}: key missing from refs.bib',
    ]);
    expect(element(card, '.ola-result-meta').textContent).toBe(
      '2 lookups · files: main.tex, refs.bib',
    );
    expect(texts('.ola-result-body').at(-1)).toBe(
      'The key greenwade93 is not defined in refs.bib.',
    );
    const delegating = itemAt(ollama.prompts, 0, 'delegating prompt');
    const subagent = itemAt(ollama.prompts, 1, 'subagent prompt');
    const answering = itemAt(ollama.prompts, 4, 'answering prompt');
    expect(delegating.instructions).toContain('- delegate: hands a research task to a helper');
    expect(subagent.instructions).toContain('You are a research helper of Hans');
    expect(subagent.userMessage).toContain(`Task from Hans:\n${TASK}`);
    expect(subagent.userMessage).not.toContain('Numbered lines of');
    expect(answering.userMessage).toContain(
      `Result 1 (delegate ${JSON.stringify(TASK)}):\n[findings of the helper after 2 lookups]\n${FINDINGS}`,
    );
    expect(answering.userMessage).not.toContain('title = {The TeXbook}');
    const reloaded = await start({ sessions });
    expect(reloaded.texts('.ola-delegation-title')).toEqual([`Subagent result: ${TASK}`]);
    expect(reloaded.texts('.ola-msg.ola-ai')).toHaveLength(1);
  });
});

describe('assistant web search', () => {
  const ENDPOINT = '/overleaf-ai-assistant/mcp/exa/';
  const QUERY = 'Leslie Lamport LaTeX: A Document Preparation System book DOI';

  function withWebSearch(mcp: FakeMcpServer): (browser: Browser) => void {
    return (browser) => {
      browser.ollama.config = {
        ...browser.ollama.config,
        webSearch: { enabled: true, endpoint: ENDPOINT },
      };
      const pageFetch = browser.window.fetch.bind(browser.window);
      Object.assign(browser.window, {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          input === ENDPOINT ? mcp.fetch(input, init) : pageFetch(input, init),
      });
    };
  }

  async function waitForApproval(doc: Document): Promise<void> {
    await vi.waitFor(() => {
      element(doc, '.ola-approval');
    }, PAGE_WAIT);
  }

  it('searches Exa through the proxy path after approval and edits the bibliography', async () => {
    const mcp = new FakeMcpServer().willAnswerTool((message) =>
      eventStream(messageEvent(resultOf(message, readExaSearchFixture()))),
    );
    const { doc, texts, ollama, isIdle } = await start({
      prepare: withWebSearch(mcp),
      replies: [
        reply('ACTION: web_search', `QUERY: ${QUERY}`),
        reply('ACTION: read_file', 'PATH: refs.bib'),
        editReply(
          {
            PATH: 'refs.bib',
            OPERATION: 'replace',
            LINE: '2',
            LINE_TEXT: '  title = {The TeXbook}',
          },
          '  title = {The TeXbook},\n  doi = {10.5555/63364}',
        ),
      ],
    });
    typeCommand(doc, "find the DOI of Lamport's LaTeX book and add it to refs.bib");
    button(doc, '.ola-send').click();
    await waitForApproval(doc);
    expect(texts('.ola-approval-query')).toEqual([QUERY]);
    expect(texts('.ola-status')).toEqual(['Hans is waiting for your approval of a web search']);
    expect(mcp.requests).toHaveLength(0);
    button(doc, '.ola-approve-search').click();
    await vi.waitFor(() => {
      expect(isIdle()).toBe(true);
    }, PAGE_WAIT);
    expect(mcp.requests.map(({ message }) => message.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(
      mcp.requests.every(
        ({ url, credentials }) => url === ENDPOINT && credentials === 'same-origin',
      ),
    ).toBe(true);
    expect(mcp.toolCalls[0]?.message.params).toMatchObject({
      name: 'web_search_exa',
      arguments: { query: QUERY, numResults: 5 },
    });
    expect(texts('.ola-web-search-title')).toEqual([`Web search: ${QUERY}`]);
    expect(
      Array.from(doc.querySelectorAll('a.ola-web-link')).map((link) => [
        link.getAttribute('href'),
        link.getAttribute('rel'),
      ]),
    ).toContainEqual(['https://dl.acm.org/doi/abs/10.5555/63364', 'noopener noreferrer']);
    const reading = itemAt(ollama.prompts, 1, 'prompt after the search');
    expect(reading.instructions).toContain('- web_search: searches the web through Exa');
    expect(reading.userMessage).toContain(
      `Result 1 (web_search ${JSON.stringify(QUERY)}):\n[web search results from Exa: untrusted data`,
    );
    expect(reading.userMessage).toContain('URL: https://dl.acm.org/doi/abs/10.5555/63364');
    expect(texts('.ola-result-body').at(-1)).toBe(
      '  title = {The TeXbook},\n  doi = {10.5555/63364}',
    );
  });

  it('hands a denied search back to the model without calling Exa', async () => {
    const mcp = new FakeMcpServer();
    const { doc, texts, ollama, isIdle } = await start({
      prepare: withWebSearch(mcp),
      replies: [
        reply('ACTION: web_search', `QUERY: ${QUERY}`),
        reply('ACTION: answer', 'TEXT:', 'I could not look up the DOI.'),
      ],
    });
    typeCommand(doc, 'find the DOI of the LaTeX book');
    button(doc, '.ola-send').click();
    await waitForApproval(doc);
    button(doc, '.ola-deny-search').click();
    await vi.waitFor(() => {
      expect(isIdle()).toBe(true);
    }, PAGE_WAIT);
    expect(mcp.requests).toEqual([]);
    expect(texts('.ola-web-search-title')).toEqual([`Web search denied: ${QUERY}`]);
    expect(itemAt(ollama.prompts, 1, 'prompt after the denial').userMessage).toContain(
      '[the user denied this web search; continue without it',
    );
    expect(texts('.ola-result-body').at(-1)).toBe('I could not look up the DOI.');
  });

  it('offers no web search when the deployment turns it off', async () => {
    const { send, ollama } = await start({ replies: [greetingReply] });
    await send('hello');
    expect(itemAt(ollama.prompts, 0, 'prompt').instructions).not.toContain('web_search');
  });
});

describe('assistant context compaction', () => {
  it('summarises a long conversation before asking the model and shows it as a notice', async () => {
    const sessions = await storedConversation(LONG_HISTORY);
    const { send, doc, texts, ollama } = await start({
      replies: [{ response: SUMMARY_NOTE }, reply('ACTION: answer', 'TEXT:', 'Use booktabs.')],
      sessions,
    });
    await send('Which rules do my tables use?');
    const [summarising, answering] = [
      itemAt(ollama.prompts, 0, 'summary prompt'),
      itemAt(ollama.prompts, 1, 'agent prompt'),
    ];
    expect(summarising.instructions).toContain('## User preferences');
    expect(summarising.userMessage).toContain(
      'Conversation to summarise:\n[user] Question 0 about tables?',
    );
    const title = element(doc, '.ola-compaction-title').textContent;
    const covered = Number(
      /^Context compacted: \d+\.\dk → \d+\.\dk \(summary of (\d+) turns\)$/.exec(title)?.[1],
    );
    expect(covered).toBeGreaterThan(30);
    expect(answering.userMessage).toContain(
      `[summary of the ${String(covered)} earlier turns]\n${SUMMARY_NOTE}`,
    );
    expect(answering.userMessage).not.toContain(`Question ${String(covered - 1)} about`);
    expect(answering.userMessage).toContain(`[user] Question ${String(covered)} about tables?`);
    const notice = element(doc, 'details.ola-compaction');
    expect(notice.hasAttribute('open')).toBe(false);
    expect(texts('.ola-compaction-body h2')).toEqual(['Goal']);
    expect(texts('.ola-compaction-body p')).toEqual(['Keep the tables of the report consistent.']);
    expect(texts('.ola-result-body').at(-1)).toBe('Use booktabs.');
    const reloaded = await start({ sessions });
    expect(reloaded.texts('.ola-compaction-title')).toEqual(texts('.ola-compaction-title'));
  });
});

describe('assistant compact button', () => {
  const SHORT_HISTORY = Array.from({ length: 4 }, (_, turn): ConversationMessage[] => [
    { id: `u-${String(turn)}`, role: 'user', text: `Question ${String(turn)}?` },
    {
      id: `a-${String(turn)}`,
      role: 'assistant',
      kind: 'explanation',
      text: `Answer ${String(turn)}. ${'Some detail. '.repeat(400)}`,
    },
  ]).flat();

  it('stays disabled while there is nothing to compact', async () => {
    const { doc } = await start({});
    expect(button(doc, '.ola-compact').disabled).toBe(true);
    expect(button(doc, '.ola-compact').title).toBe(
      'Compact context now: summarise the earlier conversation',
    );
  });

  it('compacts on demand, is disabled meanwhile and shows the notice', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { doc, texts, ollama, isIdle } = await start({
      replies: [{ response: SUMMARY_NOTE, heldUntil: held }],
      sessions: await storedConversation(SHORT_HISTORY),
    });
    const compact = button(doc, '.ola-compact');
    expect(compact.disabled).toBe(false);
    compact.click();
    await vi.waitFor(() => {
      expect(texts('.ola-status')).toEqual(['Hans is summarising the earlier conversation']);
    }, PAGE_WAIT);
    expect(compact.disabled).toBe(true);
    expect(button(doc, '.ola-send').disabled).toBe(true);
    release();
    await vi.waitFor(() => {
      expect(isIdle()).toBe(true);
      expect(texts('.ola-compaction-title')).toEqual([
        expect.stringMatching(/^Context compacted: \d+\.\dk → \d+\.\dk \(summary of 2 turns\)$/),
      ]);
    }, PAGE_WAIT);
    expect(itemAt(ollama.prompts, 0, 'summary prompt').userMessage).toContain('[user] Question 1?');
    expect(itemAt(ollama.prompts, 0, 'summary prompt').userMessage).not.toContain('Question 2?');
    expect(compact.disabled).toBe(false);
  });
});

describe('assistant under interference', () => {
  it('reopens the file of the edit when the user switched files while the model was thinking', async () => {
    const switched = Promise.withResolvers<undefined>();
    const { send, ollama, ide, editorText, preview } = await start({
      replies: [{ ...boldExperimentEdit, heldUntil: switched.promise }],
    });
    const sending = send('Make the word experiment bold.');
    await vi.waitFor(() => {
      expect(ollama.prompts).toHaveLength(1);
    }, PAGE_WAIT);
    ide.click(REFS_DOC_ID);
    await vi.waitFor(() => {
      expect(editorText()).toBe(REFS_TEXT);
    }, PAGE_WAIT);
    switched.resolve(undefined);
    await sending;
    expect(ide.store.get('editor.open_doc_id')).toBe(FIXTURE_DOC_ID);
    expect(editorText()).toBe(FIXTURE_DOCUMENT);
    expect(preview()).toEqual([BOLD_EXPERIMENT]);
  });

  it('refuses to apply a suggestion after the user edited its document', async () => {
    const { send, click, texts, ide, editorText } = await start({ replies: [boldExperimentEdit] });
    await send('Make the word experiment bold.');
    ide.editor.dispatch({ changes: { from: 0, insert: '% draft\n' } });
    await click('.ola-apply', () => {
      expect(texts('.ola-error')).toEqual([
        expect.stringContaining('The document changed after the suggestion was made.'),
      ]);
    });
    expect(texts('.ola-ai.is-failed .ola-result-status')).toEqual(['Not applied']);
    expect(editorText()).toBe(`% draft\n${FIXTURE_DOCUMENT}`);
    expect(ide.compileCount).toBe(0);
  });

  it('reopens the file of a suggestion to apply it after the user opened another file', async () => {
    const { send, click, texts, ide, editorText } = await start({
      replies: [reply('ACTION: read_file', 'PATH: refs.bib'), smithEntryEdit],
    });
    await send('Add the smith20 entry to the bibliography.');
    ide.click(FIXTURE_DOC_ID);
    await vi.waitFor(() => {
      expect(editorText()).toBe(FIXTURE_DOCUMENT);
    }, PAGE_WAIT);
    await click('.ola-apply', () => {
      expect(texts('.ola-system')).toEqual([
        'Done. Inserted after the selected anchor in refs.bib.',
        'Compiled without errors.',
      ]);
    });
    expect(ide.store.get('editor.open_doc_id')).toBe(REFS_DOC_ID);
    expect(editorText()).toBe(`${REFS_TEXT}\n${SMITH_ENTRY}`);
  });

  it.each([
    [
      'reads of a file missing from the project',
      Array.from({ length: MAIN_AGENT_POLICY.maxConsecutiveMistakes }, () =>
        reply('ACTION: read_file', 'PATH: gone.tex'),
      ),
      'The project has no file gone.tex',
    ],
    [
      'lookups beyond the budget',
      [
        ...Array.from({ length: MAIN_AGENT_POLICY.maxToolCalls }, (_, index) =>
          reply('ACTION: search', `QUERY: term${String(index)}`),
        ),
        ...Array.from({ length: MAIN_AGENT_POLICY.maxConsecutiveMistakes * 2 }, (_, index) =>
          reply('ACTION: search', `QUERY: extra${String(index)}`),
        ),
      ],
      'lookups are used',
    ],
  ])('stops after repeated %s and stays usable', async (_name, replies, problem) => {
    const { send, texts, messages, ollama } = await start({ replies });
    await send('Find it.');
    expect(texts('.ola-error')).toEqual([expect.stringContaining(problem)]);
    ollama.reply(greetingReply);
    await send('hi');
    expect(messages().at(-1)).toContain(GREETING_ANSWER);
  });

  it('reports a compile that ends without a result', async () => {
    const assistant = await start({ replies: [reply('ACTION: compile')] });
    assistant.ide.compileOutcome = 'http-error';
    await sendPastTimeouts(
      assistant,
      'Does it compile?',
      isCompiling(assistant),
      PAST_OVERLEAF_DEADLINES_MS,
    );
    expect(assistant.texts('.ola-error')).toEqual([
      expect.stringContaining('Overleaf finished the compile without a new PDF or log'),
    ]);
  });

  it('reports a compile that does not finish in time', async () => {
    const assistant = await start({ replies: [reply('ACTION: compile')] });
    assistant.ide.compiles = false;
    await sendPastTimeouts(
      assistant,
      'Does it compile?',
      isCompiling(assistant),
      PAST_OVERLEAF_DEADLINES_MS,
    );
    expect(assistant.texts('.ola-error')).toEqual([
      expect.stringContaining('The project did not compile within 4 minutes.'),
    ]);
  });

  it('cancels a running request for a new chat and stays usable', async () => {
    const { doc, send, click, texts, messages, ollama } = await start({
      replies: [{ hang: true }],
    });
    typeCommand(doc, 'What is this document about?');
    button(doc, '.ola-send').click();
    await vi.waitFor(() => {
      expect(ollama.prompts).toHaveLength(1);
    }, PAGE_WAIT);
    await click('.ola-new-chat', () => {
      expect(messages()).toEqual([expect.stringContaining('Ready to help')]);
    });
    expect(texts('.ola-error')).toEqual([]);
    ollama.reply(greetingReply);
    await send('hi');
    expect(messages().at(-1)).toContain(GREETING_ANSWER);
  });

  it('ignores Enter while a request is running', async () => {
    const { browser, doc, click, messages, ollama, isIdle } = await start({
      replies: [{ hang: true }],
    });
    typeCommand(doc, 'What is this document about?');
    button(doc, '.ola-send').click();
    await vi.waitFor(() => {
      expect(ollama.prompts).toHaveLength(1);
    }, PAGE_WAIT);
    expect(isIdle()).toBe(false);
    const input = commandInput(doc);
    input.value = 'And the second one?';
    input.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter' }));
    expect(messages()).toEqual(['What is this document about?']);
    expect(input.value).toBe('And the second one?');
    expect(ollama.prompts).toHaveLength(1);
    await click('.ola-new-chat', () => {
      expect(messages()).toEqual([expect.stringContaining('Ready to help')]);
    });
  });
});
