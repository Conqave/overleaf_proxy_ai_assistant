import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { editorLines, FIXTURE_HTML, openBrowser } from '../support/browser';
import { FakeOllama } from '../support/fake-ollama';

const BUNDLE = new URL('../../dist/overleaf-ai-assistant.js', import.meta.url);
const HISTORY_KEY = 'ola-conversation:user-1:project-1';
const json = (value: unknown) => ({ response: JSON.stringify(value) });
const text = (value: string) => ({ response: value });
const edit = (fields: Record<string, string | number>, content?: string) =>
  text(
    [
      ...Object.entries(fields).map(([name, value]) => `${name}: ${String(value)}`),
      ...(content === undefined ? [] : ['CONTENT:', content]),
    ].join('\n'),
  );

async function start(
  options: { ollama?: FakeOllama; storage?: Record<string, string>; openEditor?: boolean } = {},
) {
  const browser = openBrowser(options);
  await browser.settle();
  browser.inject(readFileSync(BUNDLE, 'utf8'));
  const editor = options.openEditor === false ? null : browser.openEditor();
  await browser.settle();
  const doc = browser.document;
  const send = async (text: string) => {
    doc.querySelector<HTMLTextAreaElement>('.ola-textarea')!.value = text;
    doc.querySelector<HTMLButtonElement>('.ola-send')!.click();
    await browser.settle();
  };
  const messages = () => Array.from(doc.querySelectorAll('.ola-msg')).map((m) => m.textContent);
  const click = async (selector: string) => {
    doc.querySelector<HTMLButtonElement>(selector)!.click();
    await browser.settle();
  };
  return { browser, doc, editor: editor!, send, messages, click, ollama: browser.ollama };
}

function replaceLine(editor: EditorView, lineNumber: number, text: string): void {
  const line = editor.state.doc.line(lineNumber);
  editor.dispatch({ changes: { from: line.from, to: line.to, insert: text } });
}

const editPlan = json({ intent: 'edit', needs: [] });
const insertAfterResults = edit(
  {
    OPERATION: 'insert_after',
    LINE: 6,
    LINE_TEXT: 'The results are shown below.',
    REASON: 'Adds the table.',
    PLAN: 'After the results sentence.',
  },
  '\\begin{table}\n\\end{table}',
);

describe('assistant runtime', () => {
  it('opens with badge, panel and welcome message and warms the model', async () => {
    const { doc, messages, ollama } = await start();
    expect(doc.querySelector('.ola-badge')?.textContent).toBe('Hans');
    expect(doc.querySelector('.ola-head')?.textContent).toContain('Hans AI Assistant');
    expect(messages()).toEqual([expect.stringContaining('Ready to help with this document')]);
    expect(ollama.calls.filter((c) => c.body.prompt === '')).toHaveLength(1);
    doc.querySelector<HTMLButtonElement>('.ola-badge')!.click();
    expect(doc.getElementById('ola-root')!.classList.contains('is-collapsed')).toBe(true);
  });

  it('is injected only once', async () => {
    const { browser, doc } = await start();
    browser.inject(readFileSync(BUNDLE, 'utf8'));
    await browser.settle();
    expect(doc.querySelectorAll('#ola-root')).toHaveLength(1);
  });

  it('waits for the editor to appear', async () => {
    const { browser, doc } = await start({ openEditor: false });
    expect(doc.getElementById('ola-root')).toBeNull();
    browser.openEditor();
    await browser.settle();
    expect(doc.getElementById('ola-root')).not.toBeNull();
  });

  it('does not start with invalid configuration', async () => {
    const ollama = new FakeOllama();
    ollama.config = { model: '' };
    const { doc } = await start({ ollama });
    expect(doc.getElementById('ola-root')).toBeNull();
  });

  it('does not start on a page that names no user', async () => {
    const browser = openBrowser({
      html: FIXTURE_HTML.replace(/<meta name="ol-user_id"[^>]*>/, ''),
    });
    await browser.settle();
    browser.inject(readFileSync(BUNDLE, 'utf8'));
    browser.openEditor();
    await browser.settle();
    expect(browser.document.getElementById('ola-root')).toBeNull();
    expect(browser.ollama.calls).toHaveLength(0);
  });

  it('asks for a command when the input is empty', async () => {
    const { send, messages, ollama } = await start();
    await send('  ');
    expect(messages().at(-1)).toBe('Error: Please enter a command for the assistant.');
    expect(ollama.promptCalls).toHaveLength(0);
  });

  it('answers a greeting locally', async () => {
    const { send, messages, ollama, doc } = await start();
    await send('hello');
    expect(ollama.promptCalls).toHaveLength(0);
    expect(messages()).toEqual(['hello', expect.stringContaining('Hi, I am here')]);
    expect(doc.querySelector<HTMLTextAreaElement>('.ola-textarea')!.value).toBe('');
  });

  it('summarizes the document', async () => {
    const ollama = new FakeOllama().reply(
      json({ intent: 'summary', needs: [] }),
      text('An experiment report.'),
    );
    const { send, messages } = await start({ ollama });
    await send('o czym jest dokument?');
    expect(ollama.promptCalls[1]!.body.prompt).toContain('This report describes the experiment.');
    expect(ollama.promptCalls.every((c) => !('format' in c.body))).toBe(true);
    expect(ollama.promptCalls.every((c) => c.body.options?.num_ctx === 16_384)).toBe(true);
    expect(messages().at(-1)).toBe('Document summaryAn experiment report.');
  });

  it('explains using compile logs', async () => {
    const ollama = new FakeOllama().reply(
      json({ intent: 'explain', needs: ['logs'] }),
      text('A macro is undefined.'),
    );
    const { send, messages } = await start({ ollama });
    await send('why does it fail?');
    expect(ollama.promptCalls[1]!.body.prompt).toContain('Undefined control sequence');
    expect(messages().at(-1)).toBe('ExplanationA macro is undefined.');
  });

  it('asks for clarification when the edit step cannot place the change', async () => {
    const ollama = new FakeOllama().reply(editPlan, text('QUESTION: Which table?'));
    const { doc, send, messages } = await start({ ollama });
    await send('fix the table');
    expect(messages().at(-1)).toBe('Hans needs a little more detailWhich table?');
    expect(doc.querySelector('.ola-apply')).toBeNull();
  });

  it('previews an edit and applies it only after approval', async () => {
    const ollama = new FakeOllama().reply(editPlan, insertAfterResults);
    const { doc, editor, send, messages, click } = await start({ ollama });
    const original = editorLines(editor);
    await send('add a table after the results');
    expect(messages().at(-1)).toContain('Proposed insertion');
    expect(messages().at(-1)).toContain('After the results sentence.');
    expect(messages().at(-1)).toContain('Anchor: line 6: The results are shown below.');
    expect(doc.querySelector('.ola-preview-target')?.textContent).toBe(
      'The results are shown below.',
    );
    expect(doc.querySelector('.ola-preview-added')?.textContent).toBe('\\begin{table}\\end{table}');
    expect(editorLines(editor)).toEqual(original);

    await click('.ola-apply');
    expect(doc.querySelectorAll('.ola-preview-added, .ola-preview-target')).toHaveLength(0);
    expect(editorLines(editor).slice(5, 8)).toEqual([
      'The results are shown below.',
      '\\begin{table}',
      '\\end{table}',
    ]);
    expect(messages().at(-1)).toBe('Done. Inserted after the selected anchor.');
    expect(doc.querySelector('.ola-apply')).toBeNull();
  });

  it('previews and deletes a range of lines', async () => {
    const ollama = new FakeOllama().reply(
      editPlan,
      edit({
        OPERATION: 'delete',
        LINE: 3,
        END_LINE: 4,
        LINE_TEXT: '\\section{Introduction}',
        REASON: 'Drops the introduction.',
        PLAN: 'Removes the section and its text.',
      }),
    );
    const { doc, editor, send, messages, click } = await start({ ollama });
    const original = editorLines(editor);
    await send('delete the introduction');
    expect(messages().at(-1)).toContain('Lines 3–4, starting: \\section{Introduction}');
    expect(doc.querySelectorAll('.ola-preview-removed')).toHaveLength(2);
    expect(editorLines(editor)).toEqual(original);

    await click('.ola-apply');
    expect(editorLines(editor)).toEqual([...original.slice(0, 2), ...original.slice(4)]);
    expect(messages().at(-1)).toBe('Done. 2 lines deleted.');
  });

  it('rejects an edit, removing preview, proposal and history entry', async () => {
    const ollama = new FakeOllama().reply(editPlan, insertAfterResults);
    const { browser, doc, editor, send, messages, click } = await start({ ollama });
    const original = editorLines(editor);
    await send('add a table');
    await click('.ola-reject');
    expect(messages()).toEqual(['add a table', 'Change rejected.']);
    expect(doc.querySelectorAll('.ola-preview-added, .ola-preview-target')).toHaveLength(0);
    expect(editorLines(editor)).toEqual(original);
    expect(browser.window.localStorage.getItem(HISTORY_KEY)).not.toContain('Adds the table.');
  });

  it('refuses to apply after the document changed', async () => {
    const ollama = new FakeOllama().reply(editPlan, insertAfterResults);
    const { editor, send, messages, click } = await start({ ollama });
    await send('add a table');
    replaceLine(editor, 1, '\\documentclass{report}');
    await click('.ola-apply');
    expect(messages().at(-1)).toContain('The document changed after the suggestion was made.');
    expect(editorLines(editor)).not.toContain('\\end{table}');
  });

  it('starts a new conversation during a request and drops the late reply', async () => {
    const ollama = new FakeOllama().reply(json({ intent: 'summary' }));
    let startNew: () => void = () => undefined;
    ollama.onPrompt = (call) => {
      if (call.body.system?.includes('planner')) startNew();
    };
    const { doc, send, messages } = await start({ ollama });
    startNew = () => {
      doc.querySelector<HTMLButtonElement>('.ola-new-chat')!.click();
    };
    expect(doc.querySelector<HTMLButtonElement>('.ola-new-chat')!.disabled).toBe(false);
    await send('summarize');
    expect(messages()).toEqual([
      expect.stringContaining('Ready to help'),
      expect.stringContaining('reset before the assistant finished'),
    ]);
    expect(ollama.promptCalls).toHaveLength(1);
  });

  it('drops a suggestion whose target changed before the preview', async () => {
    const ollama = new FakeOllama().reply(editPlan, insertAfterResults);
    const { doc, editor, send, messages } = await start({ ollama });
    ollama.onPrompt = (call) => {
      if (call.body.system?.includes('OPERATION:')) replaceLine(editor, 6, 'Edited meanwhile.');
    };
    await send('add a table');
    expect(messages().some((m) => m.includes('Proposed insertion'))).toBe(false);
    expect(messages().at(-1)).toContain('The document changed after the suggestion was made.');
    expect(doc.querySelector('.ola-apply')).toBeNull();
  });

  it('discards an open suggestion when a new request is sent', async () => {
    const ollama = new FakeOllama().reply(editPlan, insertAfterResults);
    const { doc, send } = await start({ ollama });
    await send('add a table');
    await send('hi');
    expect(doc.querySelector('.ola-apply')).toBeNull();
    expect(doc.querySelectorAll('.ola-preview-added')).toHaveLength(0);
  });

  it('retries invalid model output once, then reports a protocol error', async () => {
    const ollama = new FakeOllama().reply(
      { response: '{"intent": "summary",' },
      { response: 'Sure, here is a summary' },
    );
    const { send, messages } = await start({ ollama });
    await send('summarize');
    expect(ollama.promptCalls).toHaveLength(2);
    expect(messages().at(-1)).toMatch(/^Error: The assistant replied in an unexpected format/);
  });

  it('never applies an invalid edit', async () => {
    const bad = edit(
      { OPERATION: 'replace_line', LINE: 6, LINE_TEXT: 'x', REASON: 'r', PLAN: 'p' },
      'y',
    );
    const ollama = new FakeOllama().reply(editPlan, bad, bad);
    const { doc, editor, send, messages } = await start({ ollama });
    const before = editorLines(editor);
    await send('rewrite');
    expect(doc.querySelector('.ola-apply')).toBeNull();
    expect(editorLines(editor)).toEqual(before);
    expect(messages().at(-1)).toContain('unknown operation');
  });

  it('reports a target line the model cannot quote even after the correction', async () => {
    const wrong = edit({
      OPERATION: 'delete',
      LINE: 2,
      LINE_TEXT: 'Not in the document.',
      REASON: 'r',
      PLAN: 'p',
    });
    const ollama = new FakeOllama().reply(editPlan, wrong, wrong);
    const { doc, send, messages } = await start({ ollama });
    await send('delete it');
    expect(ollama.promptCalls[2]!.body.prompt).toContain('copied from the start of line 2');
    expect(messages().at(-1)).toMatch(/^Error: The assistant replied in an unexpected format/);
    expect(doc.querySelector('.ola-apply')).toBeNull();
  });

  it('reports an Ollama timeout', async () => {
    const ollama = new FakeOllama().reply({ hang: true });
    const { browser, send, messages, doc } = await start({ ollama });
    await send('summarize');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await browser.settle();
    expect(messages().at(-1)).toMatch(/^Error: Ollama did not respond within/);
    expect(doc.querySelector<HTMLButtonElement>('.ola-send')!.disabled).toBe(false);
  });

  it('reports Ollama HTTP errors', async () => {
    const ollama = new FakeOllama().reply({ status: 502 });
    const { send, messages } = await start({ ollama });
    await send('summarize');
    expect(messages().at(-1)).toBe('Error: Ollama answered HTTP 502');
  });

  it('reports an unavailable editor', async () => {
    const { editor, send, messages } = await start();
    editor.destroy();
    await send('summarize');
    expect(messages().at(-1)).toBe('Error: The Overleaf editor is not available.');
  });

  it('reloads history and starts a new conversation', async () => {
    const first = await start();
    await first.send('hi');
    const stored = first.browser.window.localStorage.getItem(HISTORY_KEY)!;
    const second = await start({ storage: { [HISTORY_KEY]: stored } });
    expect(second.messages()).toEqual(['hi', expect.stringContaining('Hi, I am here')]);
    await second.click('.ola-new-chat');
    expect(second.messages()).toEqual([expect.stringContaining('Ready to help')]);
    expect(second.browser.window.localStorage.getItem(HISTORY_KEY)).toBeNull();
  });

  it('reports corrupted history and continues', async () => {
    const { messages, send } = await start({ storage: { [HISTORY_KEY]: '{oops' } });
    expect(messages().at(-1)).toContain('The saved conversation is corrupted');
    await send('hi');
    expect(messages().at(-1)).toContain('Hi, I am here');
  });

  it('sends with Enter, not with Shift+Enter, and leaves page shortcuts alone', async () => {
    const { browser, doc, messages } = await start();
    const input = doc.querySelector<HTMLTextAreaElement>('.ola-textarea')!;
    const { KeyboardEvent } = browser.window;
    input.value = 'hi';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    await browser.settle();
    expect(messages()).toEqual([expect.stringContaining('Ready to help')]);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await browser.settle();
    expect(messages()).toEqual(['hi', expect.stringContaining('Hi, I am here')]);
    input.value = 'hey';
    const inspect = new KeyboardEvent('keydown', {
      code: 'KeyC',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    browser.window.dispatchEvent(inspect);
    await browser.settle();
    expect(inspect.defaultPrevented).toBe(false);
    expect(messages()).toHaveLength(2);
  });
});
