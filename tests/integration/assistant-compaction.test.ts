import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '../../src/domain/conversation';
import { IndexedDbSessionRepository } from '../../src/infrastructure/persistence/indexed-db-session-repository';
import { itemAt } from '../support/guards';
import { PAGE_WAIT, closeBrowsers, element, button, start, reply } from '../support/assistant-page';

afterEach(closeBrowsers);

async function storedConversation(messages: ConversationMessage[]): Promise<IDBFactory> {
  const sessions = new IDBFactory();
  const repository = new IndexedDbSessionRepository(
    { indexedDB: sessions },
    { userId: 'user-1', projectId: 'project-1' },
  );
  await repository.save({
    id: 'stored',
    title: 'Stored',
    createdAt: 1,
    updatedAt: 2,
    messages,
    imported: null,
    contextUsage: null,
  });
  return sessions;
}

const LONG_HISTORY = Array.from({ length: 50 }, (_, turn): ConversationMessage[] => [
  { id: `u-${String(turn)}`, role: 'user', text: `Question ${String(turn)} about tables?` },
  {
    id: `a-${String(turn)}`,
    role: 'assistant',
    kind: 'explanation',
    text: `Answer ${String(turn)}: ${'Use booktabs rules and caption every table. '.repeat(70)}`,
  },
]).flat();

const SUMMARY_NOTE = '## Goal\nKeep the tables of the report consistent.';

describe('assistant context compaction', () => {
  it('summarises a long conversation before asking the model and shows it as a notice', async () => {
    const sessions = await storedConversation(LONG_HISTORY);
    const { send, doc, texts, ollama } = await start({
      replies: [{ response: SUMMARY_NOTE }, reply('ACTION: answer', 'TEXT:', 'Use booktabs.')],
      sessions,
    });
    await send('Which rules do my tables use?');
    const [summarising, answering] = [
      itemAt(ollama.prompts, 0, 'summary prompt'),
      itemAt(ollama.prompts, 1, 'agent prompt'),
    ];
    expect(summarising.instructions).toContain('## User preferences');
    expect(summarising.userMessage).toContain(
      'Conversation to summarise:\n[user] Question 0 about tables?',
    );
    const title = element(doc, '.ola-compaction-title').textContent;
    const covered = Number(
      /^Conversation history compacted: \d+\.\dk → \d+\.\dk tokens \(summary of (\d+) turns\)$/.exec(
        title,
      )?.[1],
    );
    expect(covered).toBeGreaterThan(30);
    expect(answering.userMessage).toContain(
      `[summary of the ${String(covered)} earlier turns]\n${SUMMARY_NOTE}`,
    );
    expect(answering.userMessage).not.toContain(`Question ${String(covered - 1)} about`);
    expect(answering.userMessage).toContain(`[user] Question ${String(covered)} about tables?`);
    const notice = element(doc, 'details.ola-compaction');
    expect(notice.hasAttribute('open')).toBe(false);
    expect(texts('.ola-compaction-body h2')).toEqual(['Goal']);
    expect(texts('.ola-compaction-body p')).toEqual(['Keep the tables of the report consistent.']);
    expect(texts('.ola-result-body').at(-1)).toBe('Use booktabs.');
    const reloaded = await start({ sessions });
    expect(reloaded.texts('.ola-compaction-title')).toEqual(texts('.ola-compaction-title'));
  });
});

describe('assistant compact button', () => {
  const SHORT_HISTORY = Array.from({ length: 4 }, (_, turn): ConversationMessage[] => [
    { id: `u-${String(turn)}`, role: 'user', text: `Question ${String(turn)}?` },
    {
      id: `a-${String(turn)}`,
      role: 'assistant',
      kind: 'explanation',
      text: `Answer ${String(turn)}. ${'Some detail. '.repeat(400)}`,
    },
  ]).flat();

  it('stays disabled while there is nothing to compact', async () => {
    const { doc } = await start({});
    expect(button(doc, '.ola-compact').disabled).toBe(true);
    expect(button(doc, '.ola-compact').title).toBe(
      'Nothing to compact yet: the earlier conversation is too short to summarise',
    );
  });

  it('compacts on demand, is disabled meanwhile and shows the notice', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { doc, texts, ollama, isIdle } = await start({
      replies: [{ response: SUMMARY_NOTE, heldUntil: held }],
      sessions: await storedConversation(SHORT_HISTORY),
    });
    const compact = button(doc, '.ola-compact');
    expect(compact.disabled).toBe(false);
    compact.click();
    await vi.waitFor(() => {
      expect(texts('.ola-status')).toEqual(['Hans is summarising the earlier conversation']);
    }, PAGE_WAIT);
    expect(compact.disabled).toBe(true);
    expect(compact.title).toBe('Compacting is possible once Hans has finished');
    expect(button(doc, '.ola-send').disabled).toBe(true);
    release();
    await vi.waitFor(() => {
      expect(isIdle()).toBe(true);
      expect(texts('.ola-compaction-title')).toEqual([
        expect.stringMatching(
          /^Conversation history compacted: \d+\.\dk → \d+\.\dk tokens \(summary of 2 turns\)$/,
        ),
      ]);
    }, PAGE_WAIT);
    expect(itemAt(ollama.prompts, 0, 'summary prompt').userMessage).toContain('[user] Question 1?');
    expect(itemAt(ollama.prompts, 0, 'summary prompt').userMessage).not.toContain('Question 2?');
    expect(compact.disabled).toBe(false);
  });
});
