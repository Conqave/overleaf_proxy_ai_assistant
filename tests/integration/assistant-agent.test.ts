import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPILE_FIX_REQUEST } from '../../src/application/conversation-agent';
import { COMPILE_FIX_NOTE } from '../../src/presentation/message-format';
import {
  FAKE_AGENT_STEP_TIMEOUT_MS,
  type OllamaReply,
  type ResponseReply,
} from '../support/fake-ollama';
import { FIXTURE_DOC_ID } from '../support/fake-overleaf';
import { itemAt } from '../support/guards';
import { TestFixtureError } from '../support/test-errors';
import {
  PAGE_WAIT,
  REFS_DOC_ID,
  REFS_TEXT,
  SMITH_ENTRY,
  UNUSED_CONTEXT,
  closeBrowsers,
  element,
  sendPastTimeouts,
  start,
  reply,
  GREETING_ANSWER,
  greetingReply,
  editReply,
  EXPERIMENT_LINE,
  BOLD_EXPERIMENT,
  boldExperimentEdit,
  smithEntryEdit,
  contextText,
  undefinedCommandLog,
} from '../support/assistant-page';

afterEach(closeBrowsers);

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
    expect(texts('.ola-result-meta').at(-1)).toBe('refs.bib, after line 3: }');
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
        'Done. Inserted after line 3 in refs.bib.',
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
      'refs.bib, after line 3: }',
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
        COMPILE_FIX_NOTE,
        expect.stringContaining('Proposed replacement'),
      ]);
      expect(texts('.ola-system-request')).toEqual([COMPILE_FIX_NOTE]);
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
        COMPILE_FIX_NOTE,
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
