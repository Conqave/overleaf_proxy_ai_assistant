import { afterEach, describe, expect, it, vi } from 'vitest';
import { itemAt } from '../support/guards';
import { readStoredSessions } from '../support/session-store';
import {
  PAGE_WAIT,
  UNUSED_CONTEXT,
  closeBrowsers,
  button,
  commandInput,
  typeCommand,
  start,
  denyStorage,
  GREETING_ANSWER,
  greetingReply,
} from '../support/assistant-page';

afterEach(closeBrowsers);

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
