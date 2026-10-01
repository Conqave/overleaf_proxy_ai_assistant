import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { type Browser, openBrowser } from '../support/browser';
import { FakeOllama } from '../support/fake-ollama';

const BUNDLE = readFileSync(
  new URL('../../dist/overleaf-ai-assistant.js', import.meta.url),
  'utf8',
);
const HISTORY_KEY = 'ola-conversation:user-1:project-1';
const EXTENSIONS_EVENT = 'UNSTABLE_editor:extensions';
const PAGE_WAIT = { timeout: 10_000 };

const browsers: Browser[] = [];

afterEach(() => {
  for (const browser of browsers.splice(0)) browser.close();
});

function open(ollama: FakeOllama): Browser {
  const browser = openBrowser(ollama);
  browsers.push(browser);
  return browser;
}

async function waitForStartupFailure(browser: Browser): Promise<void> {
  await vi.waitFor(() => {
    expect(browser.consoleErrors).toEqual([
      expect.stringContaining('[overleaf-ai-assistant] not started'),
    ]);
  }, PAGE_WAIT);
}

function session(browser: Browser, editor: EditorView) {
  const doc = browser.document;
  const messages = () => Array.from(doc.querySelectorAll('.ola-msg')).map((m) => m.textContent);
  const sendButton = () => doc.querySelector<HTMLButtonElement>('.ola-send')!;
  const send = async (request: string) => {
    const before = messages().length;
    doc.querySelector<HTMLTextAreaElement>('.ola-textarea')!.value = request;
    sendButton().click();
    await vi.waitFor(() => {
      expect(messages().length).toBeGreaterThan(before);
      expect(sendButton().disabled).toBe(false);
    }, PAGE_WAIT);
  };
  const click = (selector: string) => {
    doc.querySelector<HTMLButtonElement>(selector)!.click();
  };
  return { browser, doc, editor, send, messages, click, ollama: browser.ollama };
}

async function waitForAssistant(browser: Browser): Promise<void> {
  await vi.waitFor(() => {
    expect(browser.document.querySelectorAll('#ola-root .ola-msg').length).toBeGreaterThan(0);
  }, PAGE_WAIT);
}

async function start(options: { ollama: FakeOllama; storage?: Record<string, string> }) {
  const browser = open(options.ollama);
  if (options.storage !== undefined) {
    for (const [key, value] of Object.entries(options.storage)) {
      browser.window.localStorage.setItem(key, value);
    }
  }
  browser.inject(BUNDLE);
  const editor = browser.openEditor();
  await waitForAssistant(browser);
  return session(browser, editor);
}

describe('assistant runtime', () => {
  it('opens with badge, panel and welcome message and warms the model', async () => {
    const { doc, messages, ollama } = await start({ ollama: new FakeOllama() });
    await vi.waitFor(() => {
      expect(ollama.calls.filter((c) => c.body.prompt === '')).toHaveLength(1);
    }, PAGE_WAIT);
    expect(doc.querySelector('.ola-badge')?.textContent).toBe('Hans');
    expect(doc.querySelector('.ola-head')?.textContent).toContain('Hans AI Assistant');
    expect(messages()).toEqual([expect.stringContaining('Ready to help with this document')]);
    expect(ollama.calls.filter((c) => c.body.prompt === '')).toHaveLength(1);
    doc.querySelector<HTMLButtonElement>('.ola-badge')!.click();
    expect(doc.getElementById('ola-root')!.classList.contains('is-collapsed')).toBe(true);
  });

  it('is injected only once', async () => {
    const { browser, doc } = await start({ ollama: new FakeOllama() });
    const detach = vi.spyOn(browser.window, 'removeEventListener');
    browser.inject(BUNDLE);
    browser.openEditor();
    await vi.waitFor(() => {
      expect(detach).toHaveBeenCalledWith(EXTENSIONS_EVENT, expect.any(Function));
    }, PAGE_WAIT);
    expect(doc.querySelectorAll('#ola-root')).toHaveLength(1);
  });

  it('waits for the editor to appear', async () => {
    const browser = open(new FakeOllama());
    browser.inject(BUNDLE);
    expect(browser.document.getElementById('ola-root')).toBeNull();
    browser.openEditor();
    await waitForAssistant(browser);
  });

  it('does not start with invalid configuration', async () => {
    const ollama = new FakeOllama();
    ollama.config = { model: '' };
    const browser = open(ollama);
    browser.inject(BUNDLE);
    browser.openEditor();
    await waitForStartupFailure(browser);
    expect(browser.document.getElementById('ola-root')).toBeNull();
  });

  it('does not start on a page that names no user', async () => {
    const browser = open(new FakeOllama());
    browser.document.querySelector('meta[name="ol-user_id"]')!.remove();
    browser.inject(BUNDLE);
    browser.openEditor();
    await waitForStartupFailure(browser);
    expect(browser.document.getElementById('ola-root')).toBeNull();
    expect(browser.ollama.calls).toHaveLength(0);
  });

  it('does not start without the Overleaf store', async () => {
    const browser = open(new FakeOllama());
    browser.inject(BUNDLE);
    browser.openEditor();
    Reflect.deleteProperty(browser.window, 'overleaf');
    await waitForStartupFailure(browser);
    expect(browser.consoleErrors[0]).toContain('window.overleaf.unstable.store');
    expect(browser.document.getElementById('ola-root')).toBeNull();
  });

  it('asks for a command when the input is empty', async () => {
    const { send, messages, ollama } = await start({ ollama: new FakeOllama() });
    await send('  ');
    expect(messages().at(-1)).toBe('Error: Please enter a command for the assistant.');
    expect(ollama.promptCalls).toHaveLength(0);
  });

  it('answers a greeting locally', async () => {
    const { send, messages, ollama, doc } = await start({ ollama: new FakeOllama() });
    await send('hello');
    expect(ollama.promptCalls).toHaveLength(0);
    expect(messages()).toEqual(['hello', expect.stringContaining('Hi, I am here')]);
    expect(doc.querySelector<HTMLTextAreaElement>('.ola-textarea')!.value).toBe('');
  });

  it('reloads history and starts a new conversation', async () => {
    const first = await start({ ollama: new FakeOllama() });
    await first.send('hi');
    const stored = first.browser.window.localStorage.getItem(HISTORY_KEY)!;
    const second = await start({ ollama: new FakeOllama(), storage: { [HISTORY_KEY]: stored } });
    expect(second.messages()).toEqual(['hi', expect.stringContaining('Hi, I am here')]);
    second.click('.ola-new-chat');
    expect(second.messages()).toEqual([expect.stringContaining('Ready to help')]);
    expect(second.browser.window.localStorage.getItem(HISTORY_KEY)).toBeNull();
  });

  it('reports corrupted history and continues', async () => {
    const { messages, send } = await start({
      ollama: new FakeOllama(),
      storage: { [HISTORY_KEY]: '{oops' },
    });
    expect(messages().at(-1)).toContain('The saved conversation is corrupted');
    await send('hi');
    expect(messages().at(-1)).toContain('Hi, I am here');
  });

  it('sends with Enter, not with Shift+Enter, and leaves page shortcuts alone', async () => {
    const { browser, doc, messages } = await start({ ollama: new FakeOllama() });
    const input = doc.querySelector<HTMLTextAreaElement>('.ola-textarea')!;
    const { KeyboardEvent } = browser.window;
    input.value = 'hi';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    expect(messages()).toEqual([expect.stringContaining('Ready to help')]);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.waitFor(() => {
      expect(messages()).toEqual(['hi', expect.stringContaining('Hi, I am here')]);
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
