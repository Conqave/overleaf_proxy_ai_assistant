import { beforeEach, describe, expect, it } from 'vitest';
import { CompactConversation } from '../../../src/application/compact-conversation';
import { ConversationCompactor } from '../../../src/application/conversation-compactor';
import {
  NothingToCompactError,
  RequestInProgressError,
  RequestSupersededError,
} from '../../../src/application/errors';
import { answer, tool } from '../../support/decisions';
import {
  AssistantContextOverflowError,
  AssistantProtocolError,
  AssistantUnreachableError,
} from '../../../src/ports/errors';
import {
  coverAllButLastTurn,
  FAKE_MESSAGE_TOKENS,
  PendingStep,
  rejectOnAbort,
} from '../../support/fakes';
import { UseCaseWorld, NOW } from '../../support/use-case-world';

let world: UseCaseWorld;

beforeEach(() => {
  world = new UseCaseWorld();
});

describe('automatic compaction', () => {
  async function talk(...questions: string[]): Promise<void> {
    for (const question of questions) {
      world.agent.will(answer(`About ${question}.`));
      await world.send(question);
    }
  }

  it('summarises the older turns before a model call that nears the window', async () => {
    await talk('first', 'second');
    world.agent.plan = (trigger) => (trigger.kind === 'auto' ? coverAllButLastTurn(trigger) : null);
    world.summarizer.will('## Goal\nAnswer questions.');
    world.agent.will(answer('Third answer.'));
    world.progress = [];
    await world.send('third');
    const summary = world.conversation.messages().find((message) => message.role === 'summary');
    expect(summary).toEqual({
      id: 'id-6',
      role: 'summary',
      text: '## Goal\nAnswer questions.',
      files: { read: [], edited: [] },
      proposals: [],
      coveredUntilId: 'id-2',
      coveredTurns: 1,
      tokensBefore: 4 * FAKE_MESSAGE_TOKENS,
      tokensAfter: 3 * FAKE_MESSAGE_TOKENS,
      createdAt: NOW.toISOString(),
    });
    expect(world.summarizer.requests).toEqual([
      {
        previous: null,
        imported: null,
        covered: world.conversation.messages().slice(0, 2),
        signal: expect.anything() as unknown,
      },
    ]);
    expect(world.requestAt(-1).conversation).toEqual({
      summary,
      imported: null,
      messages: world.conversation.messages().slice(2, 4),
    });
    expect(world.progress.map((p) => p.stage)).toEqual([
      'received',
      'compacting',
      'compacted',
      'thinking',
      'measured',
    ]);
  });

  it('checks before every model call and compacts at most once per request', async () => {
    await talk('first', 'second');
    world.agent.triggers = [];
    let calls = 0;
    world.agent.plan = (trigger) => {
      calls += 1;
      return calls === 1 ? null : coverAllButLastTurn(trigger);
    };
    world.summarizer.will('## Goal\nOne.');
    world.agent.will(
      tool({ tool: 'compile' }),
      tool({ tool: 'search', query: 'ab' }),
      answer('Done.'),
    );
    world.project.willCompile([]);
    await world.send('third');
    expect(world.agent.triggers.map((trigger) => trigger.kind)).toEqual(['auto', 'auto']);
    expect(world.summarizer.requests).toHaveLength(1);
    expect(
      world.conversation.messages().filter((message) => message.role === 'summary'),
    ).toHaveLength(1);
  });

  it('drops the summary when the conversation is reset while it is written', async () => {
    await talk('first', 'second');
    world.agent.plan = coverAllButLastTurn;
    world.summarizer.will(
      new PendingStep(() => {
        world.resetLater();
        return Promise.resolve('## Goal\nLate.');
      }),
    );
    await expect(world.send('third')).rejects.toThrow(RequestSupersededError);
    await Promise.all(world.resets);
    expect(world.conversation.messages()).toEqual([]);
  });

  it('fails the request when the summary cannot be written', async () => {
    await talk('first', 'second');
    world.agent.plan = coverAllButLastTurn;
    world.summarizer.will(new AssistantProtocolError('no note'));
    await expect(world.send('third')).rejects.toThrow(AssistantProtocolError);
    expect(world.conversation.messages().some((message) => message.role === 'summary')).toBe(false);
  });
});

describe('context overflow', () => {
  async function talk(...questions: string[]): Promise<void> {
    for (const question of questions) {
      world.agent.will(answer(`About ${question}.`));
      await world.send(question);
    }
  }

  it('compacts and retries once with a shortened prompt when the model overflows', async () => {
    await talk('first', 'second');
    world.agent.shortened = [];
    world.agent.plan = (trigger) =>
      trigger.kind === 'overflow' ? coverAllButLastTurn(trigger) : null;
    world.summarizer.will('## Goal\nShort.');
    world.agent.will(new AssistantContextOverflowError('too long'), answer('It fits now.'));
    world.progress = [];
    const result = await world.send('third');
    expect(result.message).toMatchObject({ text: 'It fits now.' });
    expect(world.agent.shortened).toEqual([false, true]);
    expect(world.requestAt(-1).conversation.summary).toMatchObject({ text: '## Goal\nShort.' });
    expect(world.progress.map((p) => p.stage)).toEqual([
      'received',
      'thinking',
      'compacting',
      'compacted',
      'thinking',
      'measured',
    ]);
  });

  it('retries with a shortened prompt when there is nothing to compact', async () => {
    world.agent.will(new AssistantContextOverflowError('too long'), answer('Shortened.'));
    await expect(world.send('only')).resolves.toMatchObject({ message: { text: 'Shortened.' } });
    expect(world.agent.shortened).toEqual([false, true]);
    expect(world.summarizer.requests).toEqual([]);
  });

  it('does not retry other failures of the model', async () => {
    world.agent.will(new AssistantUnreachableError('down'));
    await expect(world.send('hi')).rejects.toThrow(AssistantUnreachableError);
    expect(world.agent.shortened).toEqual([false]);
  });
});

describe('compaction on demand', () => {
  const compactNow = () =>
    new CompactConversation({
      compactor: new ConversationCompactor({
        agent: world.agent,
        summarizer: world.summarizer,
        conversation: world.conversation,
        newId: world.newId,
        now: () => NOW,
      }),
      conversation: world.conversation,
      lock: world.lock,
    });

  async function talk(...questions: string[]): Promise<void> {
    for (const question of questions) {
      world.agent.will(answer(`About ${question}.`));
      await world.send(question);
    }
  }

  it('summarises the turns before the latest one', async () => {
    await talk('first', 'second', 'third');
    world.agent.plan = coverAllButLastTurn;
    world.summarizer.will('## Goal\nThree answers.');
    const compact = compactNow();
    expect(compact.canCompact()).toBe(true);
    world.progress = [];
    const summary = await compact.execute(world.record);
    expect(summary).toMatchObject({
      role: 'summary',
      coveredUntilId: 'id-4',
      coveredTurns: 2,
      tokensBefore: 6 * FAKE_MESSAGE_TOKENS,
      tokensAfter: 3 * FAKE_MESSAGE_TOKENS,
    });
    expect(world.agent.triggers.at(-1)).toEqual({
      kind: 'manual',
      conversation: {
        summary: null,
        imported: null,
        messages: world.conversation.messages().slice(0, 6),
      },
    });
    expect(world.conversation.messages().at(-1)).toBe(summary);
    expect(world.progress.map((p) => p.stage)).toEqual(['compacting', 'compacted']);
    expect(world.busy).toEqual([true, false, true, false, true, false, true, false]);
  });

  it('rolls the previous summary into the next one', async () => {
    await talk('first', 'second');
    world.agent.plan = coverAllButLastTurn;
    world.summarizer.will('## Goal\nOne.', '## Goal\nTwo.');
    const compact = compactNow();
    const first = await compact.execute(world.record);
    await talk('third');
    const second = await compact.execute(world.record);
    expect(world.summarizer.requests[1]).toMatchObject({ previous: first });
    expect(second).toMatchObject({ coveredTurns: 2, text: '## Goal\nTwo.' });
  });

  it('refuses when there is nothing to compact', async () => {
    await talk('only');
    world.agent.plan = coverAllButLastTurn;
    const compact = compactNow();
    expect(compact.canCompact()).toBe(false);
    await expect(compact.execute(world.record)).rejects.toThrow(NothingToCompactError);
    expect(world.summarizer.requests).toEqual([]);
  });

  it('waits for no running request', async () => {
    await talk('first', 'second');
    world.agent.plan = (trigger) =>
      trigger.kind === 'manual' ? coverAllButLastTurn(trigger) : null;
    world.agent.will(new PendingStep(rejectOnAbort));
    const running = world.send('third');
    await expect(compactNow().execute(world.record)).rejects.toThrow(RequestInProgressError);
    const reset = world.startNew();
    await expect(running).rejects.toThrow(RequestSupersededError);
    await reset;
  });
});
