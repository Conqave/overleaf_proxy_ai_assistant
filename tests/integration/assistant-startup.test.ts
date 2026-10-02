import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeOllama } from '../support/fake-ollama';
import {
  BUNDLE,
  PAGE_WAIT,
  UNUSED_CONTEXT,
  closeBrowsers,
  open,
  waitForStartupFailure,
  waitForAssistant,
  element,
  button,
  start,
  BOLD_EXPERIMENT,
  boldExperimentEdit,
  PANEL_COLLAPSED_KEY,
} from '../support/assistant-page';

afterEach(closeBrowsers);

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

  it('remembers a collapsed panel in this browser over a reload', async () => {
    const opened = await start({});
    button(opened.doc, '.ola-badge').click();
    const remembered = opened.browser.window.localStorage.getItem(PANEL_COLLAPSED_KEY);
    expect(remembered).toBe('true');
    const reloaded = await start({
      prepare: (browser) => {
        browser.window.localStorage.setItem(PANEL_COLLAPSED_KEY, String(remembered));
      },
    });
    const root = element(reloaded.doc, '#ola-root');
    expect(root.classList.contains('is-collapsed')).toBe(true);
    button(reloaded.doc, '.ola-badge').click();
    expect(root.classList.contains('is-collapsed')).toBe(false);
    expect(reloaded.browser.window.localStorage.getItem(PANEL_COLLAPSED_KEY)).toBe('false');
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
