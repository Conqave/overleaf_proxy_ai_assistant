import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPILE_FIX_REQUEST } from '../../src/application/handle-assistant-request';
import { AGENT_POLICY } from '../../src/domain/agent-policy';
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
  type FakeOverleafIde,
} from '../support/fake-overleaf';
import { itemAt } from '../support/guards';
import { readStoredSessions } from '../support/session-store';
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

function session(browser: Browser, ide: FakeOverleafIde, sessions: IDBFactory) {
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
    sessions,
    doc,
    ide,
    ollama: browser.ollama,
    send,
    click,
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
  commandInput(doc).value = request;
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
}

async function start({
  replies = [],
  sessions = new IDBFactory(),
  prepare = () => undefined,
}: StartOptions) {
  const browser = open(new FakeOllama().reply(...replies), sessions);
  prepare(browser);
  browser.inject(BUNDLE);
  const ide = browser.loadOverleaf();
  await waitForAssistant(browser);
  return session(browser, ide, sessions);
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

describe('assistant conversation', () => {
  it('asks for a command when the input is empty', async () => {
    const { send, messages, ollama } = await start({});
    await send('  ');
    expect(messages().at(-1)).toBe('Error: Please enter a command for the assistant.');
    expect(ollama.prompts).toHaveLength(0);
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
      expect(reloaded.texts('.ola-system')).toEqual([COMPILE_FIX_REQUEST]);
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
      Array.from({ length: AGENT_POLICY.maxConsecutiveMistakes }, () =>
        reply('ACTION: read_file', 'PATH: gone.tex'),
      ),
      'The project has no file gone.tex',
    ],
    [
      'lookups beyond the budget',
      [
        ...Array.from({ length: AGENT_POLICY.maxToolCalls }, (_, index) =>
          reply('ACTION: search', `QUERY: term${String(index)}`),
        ),
        ...Array.from({ length: AGENT_POLICY.maxConsecutiveMistakes * 2 }, (_, index) =>
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
    commandInput(doc).value = 'What is this document about?';
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
    commandInput(doc).value = 'What is this document about?';
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
