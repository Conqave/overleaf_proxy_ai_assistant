import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { expect, vi } from 'vitest';
import { type Browser, openBrowser } from './browser';
import { FakeOllama, type OllamaPrompt, type OllamaReply, type ResponseReply } from './fake-ollama';
import {
  EMPTY_LOG_ENTRIES,
  FIXTURE_DOC_ID,
  FIXTURE_FILE_TEXTS,
  FIXTURE_ROOT_FOLDER,
  type FakeFolder,
  type FakeOverleafIde,
} from './fake-overleaf';
import { TestFixtureError } from './test-errors';

export const BUNDLE = readFileSync(
  new URL('../../dist/overleaf-ai-assistant.js', import.meta.url),
  'utf8',
);
export const PAGE_WAIT = { timeout: 10_000 };
export const PAST_OVERLEAF_DEADLINES_MS = 5 * 60_000;
export const REFS_DOC_ID = 'doc-refs';
export const REFS_TEXT = '@book{knuth84,\n  title = {The TeXbook}\n}';
export const SMITH_ENTRY = '@article{smith20,\n  title = {Smith}\n}';

export const UNUSED_CONTEXT = 'Context 0 / 98.3k';

const browsers: Browser[] = [];

export function closeBrowsers(): void {
  vi.useRealTimers();
  for (const browser of browsers.splice(0)) {
    browser.close();
    expect(browser.pageErrors).toEqual([]);
    if (!browser.expectsConsoleErrors) expect(browser.consoleErrors).toEqual([]);
  }
}

export function open(ollama: FakeOllama, sessions: IDBFactory = new IDBFactory()): Browser {
  const browser = openBrowser(ollama, sessions);
  browsers.push(browser);
  return browser;
}

export async function waitForStartupFailure(browser: Browser): Promise<void> {
  browser.expectsConsoleErrors = true;
  await vi.waitFor(() => {
    expect(browser.consoleErrors).toEqual([
      expect.stringContaining('[overleaf-ai-assistant] not started'),
    ]);
  }, PAGE_WAIT);
}

export async function waitForAssistant(browser: Browser): Promise<void> {
  await vi.waitFor(() => {
    expect(browser.document.querySelectorAll('#ola-root .ola-msg').length).toBeGreaterThan(0);
  }, PAGE_WAIT);
}

export function element(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) throw new TestFixtureError(`the page shows no ${selector}`);
  return found;
}

export function button(root: ParentNode, selector: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(selector);
  if (found === null) throw new TestFixtureError(`the page shows no ${selector} button`);
  return found;
}

export function commandInput(root: ParentNode): HTMLTextAreaElement {
  const found = root.querySelector<HTMLTextAreaElement>('.ola-textarea');
  if (found === null) throw new TestFixtureError('the page shows no command input');
  return found;
}

export function typeCommand(doc: Document, text: string): void {
  const input = commandInput(doc);
  const window = doc.defaultView;
  if (window === null) throw new TestFixtureError('the page has no window');
  input.value = text;
  input.dispatchEvent(new window.Event('input'));
}

export function session(browser: Browser, ide: FakeOverleafIde, sessions: IDBFactory) {
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

export type Session = ReturnType<typeof session>;

export function isCompiling({ texts }: Session): () => void {
  return () => {
    expect(texts('.ola-status')).toEqual(['Hans is compiling the project']);
  };
}

export async function sendPastTimeouts(
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

export interface ProjectSnapshot {
  readonly rootFolder: FakeFolder;
  readonly fileTexts: ReadonlyMap<string, string>;
}

export async function start({
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

export function signIn(userId: string, projectId: string): (browser: Browser) => void {
  return (browser) => {
    element(browser.document, 'meta[name="ol-user_id"]').setAttribute('content', userId);
    element(browser.document, 'meta[name="ol-project_id"]').setAttribute('content', projectId);
  };
}

export function denyStorage(browser: Browser): void {
  const { DOMException } = browser.window;
  Object.assign(browser.window, {
    indexedDB: {
      open: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    },
  });
}

export const reply = (...lines: readonly string[]): ResponseReply => ({
  response: lines.join('\n'),
});

export const GREETING_ANSWER = 'Hi! What should I change?';
export const greetingReply = reply('ACTION: answer', 'TEXT:', GREETING_ANSWER);

export const editReply = (fields: Record<string, string>, content: string): ResponseReply =>
  reply(
    'ACTION: edit',
    ...Object.entries(fields).map(([name, value]) => `${name}: ${value}`),
    'CONTENT:',
    content,
  );

export const EXPERIMENT_LINE = 'This report describes the experiment.';
export const BOLD_EXPERIMENT = 'This report describes the \\textbf{experiment}.';
export const boldExperimentEdit = editReply(
  { PATH: 'main.tex', OPERATION: 'replace', LINE: '4', LINE_TEXT: EXPERIMENT_LINE },
  BOLD_EXPERIMENT,
);

export const smithEntryEdit = editReply(
  { PATH: 'refs.bib', OPERATION: 'insert_after', LINE: '3', LINE_TEXT: '}' },
  SMITH_ENTRY,
);

export function contextText(call: OllamaPrompt): string {
  return `Context ${(call.promptTokens / 1000).toFixed(1)}k / 98.3k`;
}

export function undefinedCommandLog(ide: FakeOverleafIde): () => unknown {
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

export const PANEL_SIZE_KEY = 'ola-panel-size';
export const PANEL_COLLAPSED_KEY = 'ola-panel-collapsed';
