import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_POLICY } from '../support/policies';
import { FIXTURE_DOC_ID, FIXTURE_DOCUMENT } from '../support/fake-overleaf';
import {
  PAGE_WAIT,
  PAST_OVERLEAF_DEADLINES_MS,
  REFS_DOC_ID,
  REFS_TEXT,
  SMITH_ENTRY,
  closeBrowsers,
  button,
  commandInput,
  typeCommand,
  isCompiling,
  sendPastTimeouts,
  start,
  reply,
  GREETING_ANSWER,
  greetingReply,
  BOLD_EXPERIMENT,
  boldExperimentEdit,
  smithEntryEdit,
} from '../support/assistant-page';

afterEach(closeBrowsers);

describe('assistant under interference', () => {
  it('keeps the file the user opened while the model was thinking and previews on demand', async () => {
    const switched = Promise.withResolvers<undefined>();
    const { send, click, messages, ollama, ide, editorText, preview } = await start({
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
    expect(ide.store.get('editor.open_doc_id')).toBe(REFS_DOC_ID);
    expect(editorText()).toBe(REFS_TEXT);
    expect(preview()).toEqual([]);
    expect(messages().at(-1)).toBe(
      'You opened another file while Hans worked, so Hans left it open; use Show in editor to preview the change in main.tex.',
    );
    await click('.ola-preview-file', () => {
      expect(preview()).toEqual([BOLD_EXPERIMENT]);
    });
    expect(ide.store.get('editor.open_doc_id')).toBe(FIXTURE_DOC_ID);
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
        'Done. Inserted after line 3 in refs.bib.',
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

  it('stops a running request with Stop and keeps the session with a cancelled note', async () => {
    const { doc, click, messages, ollama, sessions } = await start({ replies: [{ hang: true }] });
    typeCommand(doc, 'What is this document about?');
    button(doc, '.ola-send').click();
    await vi.waitFor(() => {
      expect(ollama.prompts).toHaveLength(1);
    }, PAGE_WAIT);
    await click('.ola-stop', () => {
      expect(messages()).toEqual([
        'What is this document about?',
        'Cancelled: you stopped Hans before it finished.',
      ]);
    });
    expect(button(doc, '.ola-stop').hidden).toBe(true);
    expect(button(doc, '.ola-send').hidden).toBe(false);
    const reloaded = await start({ sessions });
    expect(reloaded.messages()).toEqual(messages());
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
