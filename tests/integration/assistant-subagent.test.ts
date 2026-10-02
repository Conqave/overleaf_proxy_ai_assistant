import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { itemAt } from '../support/guards';
import {
  PAGE_WAIT,
  closeBrowsers,
  element,
  button,
  typeCommand,
  start,
  reply,
} from '../support/assistant-page';

afterEach(closeBrowsers);

describe('assistant subagent', () => {
  const TASK = 'Check that every \\cite key of main.tex is defined in refs.bib, with path:line';
  const FINDINGS = '- main.tex:108 `\\cite{greenwade93}`: key missing from refs.bib';

  it('shows the subagent at work and its findings collapsed in the chat, also after a reload', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessions = new IDBFactory();
    const { doc, texts, ollama, isIdle } = await start({
      sessions,
      replies: [
        reply('ACTION: delegate', `TASK: ${TASK}`, 'FILES: main.tex, refs.bib'),
        { response: reply('ACTION: read_file', 'PATH: refs.bib').response, heldUntil: held },
        reply('ACTION: search', 'QUERY: \\cite{', 'PATH: main.tex'),
        reply('ACTION: answer', 'TEXT:', FINDINGS),
        reply('ACTION: answer', 'TEXT:', 'The key greenwade93 is not defined in refs.bib.'),
      ],
    });
    typeCommand(doc, 'are all my citations defined?');
    button(doc, '.ola-send').click();
    await vi.waitFor(() => {
      expect(texts('.ola-status')).toEqual(['Hans: subagent reviewing 2 files…']);
    }, PAGE_WAIT);
    release();
    await vi.waitFor(() => {
      expect(isIdle()).toBe(true);
    }, PAGE_WAIT);
    const card = element(doc, 'details.ola-delegation');
    expect(card.hasAttribute('open')).toBe(false);
    expect(texts('.ola-delegation-title')).toEqual([`Subagent result: ${TASK}`]);
    expect(texts('.ola-delegation-body li')).toEqual([
      'main.tex:108 \\cite{greenwade93}: key missing from refs.bib',
    ]);
    expect(element(card, '.ola-result-meta').textContent).toBe(
      '2 lookups · files: main.tex, refs.bib',
    );
    expect(texts('.ola-result-body').at(-1)).toBe(
      'The key greenwade93 is not defined in refs.bib.',
    );
    const delegating = itemAt(ollama.prompts, 0, 'delegating prompt');
    const subagent = itemAt(ollama.prompts, 1, 'subagent prompt');
    const answering = itemAt(ollama.prompts, 4, 'answering prompt');
    expect(delegating.instructions).toContain('- delegate: hands a research task to a helper');
    expect(subagent.instructions).toContain('You are a research helper of Hans');
    expect(subagent.userMessage).toContain(`Task from Hans:\n${TASK}`);
    expect(subagent.userMessage).not.toContain('Numbered lines of');
    expect(answering.userMessage).toContain(
      `Result 1 (delegate ${JSON.stringify(TASK)}):\n[findings of the helper after 2 lookups]\n${FINDINGS}`,
    );
    expect(answering.userMessage).not.toContain('title = {The TeXbook}');
    const reloaded = await start({ sessions });
    expect(reloaded.texts('.ola-delegation-title')).toEqual([`Subagent result: ${TASK}`]);
    expect(reloaded.texts('.ola-msg.ola-ai')).toHaveLength(1);
  });
});
