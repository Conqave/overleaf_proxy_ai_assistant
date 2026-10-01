import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Browser, openBrowser } from '../support/browser';
import { FakeOllama, type OllamaCall, type OllamaReply } from '../support/fake-ollama';
import { EMPTY_LOG_ENTRIES, FIXTURE_DOC_ID, type FakeOverleafIde } from '../support/fake-overleaf';
import { TestFixtureError } from '../support/test-errors';

const BUNDLE = readFileSync(
  new URL('../../dist/overleaf-ai-assistant.js', import.meta.url),
  'utf8',
);
const HISTORY_KEY = 'ola-conversation:user-1:project-1';
const EXTENSIONS_EVENT = 'UNSTABLE_editor:extensions';
const PAGE_WAIT = { timeout: 10_000 };
const REFS_DOC_ID = 'doc-refs';
const REFS_TEXT = '@book{knuth84,\n  title = {The TeXbook}\n}';
const SMITH_ENTRY = '@article{smith20,\n  title = {Smith}\n}';

const browsers: Browser[] = [];

afterEach(() => {
  for (const browser of browsers.splice(0)) {
    browser.close();
    expect(browser.pageErrors).toEqual([]);
  }
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

function promptCall(ollama: FakeOllama, index: number): OllamaCall {
  const call = ollama.promptCalls[index];
  if (call === undefined) throw new TestFixtureError(`Ollama got no prompt ${String(index + 1)}`);
  return call;
}

function session(browser: Browser, ide: FakeOverleafIde) {
  const doc = browser.document;
  const texts = (selector: string) =>
    Array.from(doc.querySelectorAll(selector)).map((node) => node.textContent);
  const messages = () => texts('.ola-msg');
  const isIdle = () =>
    !element(doc, '#ola-root').classList.contains('is-busy') && !button(doc, '.ola-send').disabled;
  const send = async (request: string) => {
    const before = messages().length;
    commandInput(doc).value = request;
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
  const editorText = () => ide.editor.state.doc.toString();
  const preview = () => texts('.ola-preview-added');
  return {
    browser,
    doc,
    ide,
    ollama: browser.ollama,
    send,
    click,
    texts,
    messages,
    editorText,
    preview,
  };
}

interface StartOptions {
  readonly replies?: readonly OllamaReply[];
  readonly storage?: Readonly<Record<string, string>>;
}

async function start({ replies = [], storage = {} }: StartOptions) {
  const browser = open(new FakeOllama().reply(...replies));
  for (const [key, value] of Object.entries(storage)) {
    browser.window.localStorage.setItem(key, value);
  }
  browser.inject(BUNDLE);
  const ide = browser.loadOverleaf();
  await waitForAssistant(browser);
  return session(browser, ide);
}

const reply = (...lines: readonly string[]): OllamaReply => ({ response: lines.join('\n') });

const editReply = (fields: Record<string, string>, content: string): OllamaReply =>
  reply(
    'ACTION: edit',
    ...Object.entries(fields).map(([name, value]) => `${name}: ${value}`),
    'CONTENT:',
    content,
  );

const smithEntryEdit = editReply(
  { PATH: 'refs.bib', OPERATION: 'insert_after', LINE: '3', LINE_TEXT: '}' },
  SMITH_ENTRY,
);

function contextText(call: OllamaCall): string {
  return `Context ${(call.harmonyPrompt.length / 1000).toFixed(1)}k / 16.4k`;
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
      expect(ollama.calls.filter((c) => c.body.prompt === '')).toHaveLength(1);
    }, PAGE_WAIT);
    expect(element(doc, '.ola-badge').textContent).toBe('Hans');
    expect(element(doc, '.ola-head').textContent).toContain('Hans AI Assistant');
    expect(element(doc, '.ola-context').textContent).toBe('');
    expect(messages()).toEqual([expect.stringContaining('Ready to help with this document')]);
    button(doc, '.ola-badge').click();
    expect(element(doc, '#ola-root').classList.contains('is-collapsed')).toBe(true);
  });

  it('is injected only once', async () => {
    const { browser, doc, ide } = await start({});
    const detach = vi.spyOn(browser.window, 'removeEventListener');
    browser.inject(BUNDLE);
    ide.reopenEditor();
    await vi.waitFor(() => {
      expect(detach).toHaveBeenCalledWith(EXTENSIONS_EVENT, expect.any(Function));
    }, PAGE_WAIT);
    expect(doc.querySelectorAll('#ola-root')).toHaveLength(1);
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
    expect(browser.ollama.calls).toHaveLength(0);
  });

  it('does not start without the Overleaf store', async () => {
    const browser = open(new FakeOllama());
    browser.inject(BUNDLE);
    browser.loadOverleaf();
    Reflect.deleteProperty(browser.window, 'overleaf');
    await waitForStartupFailure(browser);
    expect(browser.consoleErrors[0]).toContain('window.overleaf.unstable.store');
    expect(browser.document.getElementById('ola-root')).toBeNull();
  });
});

describe('assistant conversation', () => {
  it('asks for a command when the input is empty', async () => {
    const { send, messages, ollama } = await start({});
    await send('  ');
    expect(messages().at(-1)).toBe('Error: Please enter a command for the assistant.');
    expect(ollama.promptCalls).toHaveLength(0);
  });

  it('answers a greeting locally', async () => {
    const { send, messages, ollama, doc } = await start({});
    await send('hello');
    expect(ollama.promptCalls).toHaveLength(0);
    expect(messages()).toEqual(['hello', expect.stringContaining('Hi, I am here')]);
    expect(commandInput(doc).value).toBe('');
  });

  it('reloads history and starts a new conversation', async () => {
    const first = await start({});
    await first.send('hi');
    const stored = first.browser.window.localStorage.getItem(HISTORY_KEY);
    if (stored === null) throw new TestFixtureError('the conversation was not saved');
    const second = await start({ storage: { [HISTORY_KEY]: stored } });
    expect(second.messages()).toEqual(['hi', expect.stringContaining('Hi, I am here')]);
    await second.click('.ola-new-chat', () => {
      expect(second.messages()).toEqual([expect.stringContaining('Ready to help')]);
    });
    expect(second.browser.window.localStorage.getItem(HISTORY_KEY)).toBeNull();
  });

  it('reports corrupted history and continues', async () => {
    const { messages, send } = await start({ storage: { [HISTORY_KEY]: '{oops' } });
    expect(messages().at(-1)).toContain('The saved conversation is corrupted');
    await send('hi');
    expect(messages().at(-1)).toContain('Hi, I am here');
  });

  it('sends with Enter, not with Shift+Enter, and leaves page shortcuts alone', async () => {
    const { browser, doc, messages } = await start({});
    const input = commandInput(doc);
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

describe('assistant agent', () => {
  it('answers from the open file and shows the context usage', async () => {
    const { send, texts, ollama } = await start({
      replies: [reply('ACTION: answer', 'TEXT:', 'It describes an experiment.')],
    });
    await send('What is this document about?');
    expect(texts('.ola-result-body').at(-1)).toBe('It describes an experiment.');
    const call = promptCall(ollama, 0);
    expect(call.body.system).toContain('ACTION: read_file');
    expect(call.body.prompt).toContain(
      'Project files:\nmain.tex (open in the editor)\nrefs.bib\nfrog.jpg (binary)\nchapters/intro/intro.tex',
    );
    expect(call.body.prompt).toContain('3: \\section{Introduction}');
    expect(texts('.ola-context')).toEqual([contextText(call)]);
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
    expect(promptCall(ollama, 1).body.prompt).toContain(
      'Result 1 (search "knuth"):\nrefs.bib:1: @book{knuth84,',
    );
  });

  it('reads another file, opens it and previews an edit of it', async () => {
    const { send, texts, ollama, ide, editorText, preview } = await start({
      replies: [reply('ACTION: read_file', 'PATH: refs.bib'), smithEntryEdit],
    });
    await send('Add the smith20 entry to the bibliography.');
    expect(promptCall(ollama, 1).body.prompt).toContain(
      'Result 1 (read_file refs.bib):\n1: @book{knuth84,\n2:   title = {The TeXbook}\n3: }',
    );
    expect(ide.store.get('editor.open_doc_id')).toBe(REFS_DOC_ID);
    expect(editorText()).toBe(REFS_TEXT);
    expect(preview()).toEqual([SMITH_ENTRY.replaceAll('\n', '')]);
    expect(texts('.ola-result-meta').at(-1)).toBe('refs.bib, anchor line 3: }');
  });

  it('applies the edit of another file and compiles the project', async () => {
    const { send, click, texts, ide, editorText, preview } = await start({
      replies: [reply('ACTION: read_file', 'PATH: refs.bib'), smithEntryEdit],
    });
    await send('Add the smith20 entry to the bibliography.');
    await click('.ola-apply', () => {
      expect(texts('.ola-system')).toEqual([
        'Done. Inserted after the selected anchor in refs.bib.',
        'Compiled without errors.',
      ]);
    });
    expect(editorText()).toBe(`${REFS_TEXT}\n${SMITH_ENTRY}`);
    expect(preview()).toEqual([]);
    expect(ide.compileCount).toBe(1);
  });

  it('rejects the edit of another file and leaves it unchanged', async () => {
    const { send, click, texts, messages, ide, editorText, preview } = await start({
      replies: [reply('ACTION: read_file', 'PATH: refs.bib'), smithEntryEdit],
    });
    await send('Add the smith20 entry to the bibliography.');
    await click('.ola-reject', () => {
      expect(texts('.ola-system')).toEqual(['Change rejected.']);
    });
    expect(editorText()).toBe(REFS_TEXT);
    expect(preview()).toEqual([]);
    expect(messages()).not.toContainEqual(expect.stringContaining('Proposed insertion'));
    expect(ide.compileCount).toBe(0);
  });

  it('asks for a fix when the applied change breaks the build and applies it', async () => {
    const broken = 'This report describes the \\textbff{experiment}.';
    const fixed = 'This report describes the \\textbf{experiment}.';
    const lineFour = { PATH: 'main.tex', OPERATION: 'replace', LINE: '4' };
    const { send, click, texts, ollama, ide, editorText } = await start({
      replies: [
        editReply({ ...lineFour, LINE_TEXT: 'This report describes the experiment.' }, broken),
        editReply({ ...lineFour, LINE_TEXT: broken }, fixed),
      ],
    });
    ide.compileLog = undefinedCommandLog(ide);
    await send('Make the word experiment bold.');
    await click('.ola-apply', () => {
      expect(texts('.ola-result-body').at(-1)).toBe(fixed);
    });
    const fixPrompt = promptCall(ollama, 1).body.prompt;
    expect(fixPrompt).toContain(
      'User message:\nCompilation after the change reports errors; propose a fix.',
    );
    expect(fixPrompt).toContain(
      'Result 1 (compile):\nerror main.tex:4: Undefined control sequence.',
    );
    await click('.ola-apply', () => {
      expect(texts('.ola-system').at(-1)).toBe('Compiled without errors.');
    });
    expect(editorText().split('\n')[3]).toBe(fixed);
    expect(ide.compileCount).toBe(2);
  });

  it.each([
    ['an HTTP error', [{ status: 500 }], 'Ollama answered HTTP 500'],
    [
      'two replies in an unknown format',
      [reply('hello'), reply('ACTION: dance')],
      'The assistant replied in an unexpected format',
    ],
    [
      'a model that does not answer in time',
      [{ hang: true } as const],
      'Ollama did not respond within 200 milliseconds',
    ],
  ])('reports %s and stays usable', async (_name, replies: OllamaReply[], error) => {
    const { send, texts, messages } = await start({ replies });
    await send('What is this document about?');
    expect(texts('.ola-error')).toEqual([expect.stringContaining(error)]);
    expect(texts('.ola-status')).toEqual(['']);
    await send('hi');
    expect(messages().at(-1)).toContain('Hi, I am here');
  });
});
