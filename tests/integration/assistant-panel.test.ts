import { afterEach, describe, expect, it, vi } from 'vitest';
import { pointerEventOf } from '../support/guards';
import {
  PAGE_WAIT,
  closeBrowsers,
  element,
  button,
  typeCommand,
  type Session,
  start,
  GREETING_ANSWER,
  greetingReply,
  PANEL_SIZE_KEY,
} from '../support/assistant-page';

afterEach(closeBrowsers);

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
    expect(panelSize(opened.doc)).toEqual({ width: '380px', height: '616px' });
    dragCorner(opened, 500, 420);
    expect(panelSize(opened.doc)).toEqual({ width: '460px', height: '616px' });
    const remembered = opened.browser.window.localStorage.getItem(PANEL_SIZE_KEY);
    expect(remembered).toBe('{"width":460,"height":616}');
    const reloaded = await start({
      prepare: (browser) => {
        browser.window.localStorage.setItem(PANEL_SIZE_KEY, String(remembered));
      },
    });
    expect(panelSize(reloaded.doc)).toEqual({ width: '460px', height: '616px' });
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
