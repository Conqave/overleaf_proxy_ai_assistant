import { beforeEach, describe, expect, it } from 'vitest';
import { RequestSupersededError } from '../../../src/application/errors';
import { COMPILE_FIX_REQUEST } from '../../../src/application/conversation-agent';
import { answer } from '../../support/decisions';
import { InvariantViolation } from '../../../src/domain/errors';
import { PendingStep } from '../../support/fakes';
import { anInstanceOf } from '../../support/guards';
import { UseCaseWorld, mainEdit } from '../../support/use-case-world';

let world: UseCaseWorld;

beforeEach(() => {
  world = new UseCaseWorld();
});

describe('ReviewAppliedChange', () => {
  const reviewApplied = () =>
    world.lock.run((signal) => world.review.execute(world.record, signal));

  beforeEach(() => {
    world.conversation.append({ id: 'request', role: 'user', text: 'Make it bold.' });
  });

  it('fixes compile errors only inside a running operation', async () => {
    await expect(
      world.conversationAgent.fixCompileErrors([], world.record, new AbortController().signal),
    ).rejects.toThrow(InvariantViolation);
  });

  it('reports a clean compilation without asking the agent', async () => {
    world.project.willCompile([{ level: 'warning', message: 'Overfull \\hbox.' }]);
    await expect(reviewApplied()).resolves.toEqual({ kind: 'compiled' });
    expect(world.agent.requests).toHaveLength(0);
    expect(world.progress).toEqual([
      { stage: 'compiling' },
      {
        stage: 'noted',
        message: world.conversation.messages().at(-1),
      },
    ]);
    expect(world.conversation.messages().at(-1)).toMatchObject({
      role: 'notice',
      notice: { kind: 'compiled', errorCount: 0 },
    });
  });

  it('records the fix request as a system request, not as a user message', async () => {
    world.project.willCompile([{ level: 'error' as const, message: 'x' }]);
    world.agent.will(answer('Fixed nothing.'));
    await reviewApplied();
    expect(world.conversation.messages()[1]).toEqual({
      id: anInstanceOf(String),
      role: 'system',
      text: COMPILE_FIX_REQUEST,
    });
    expect(world.progress[1]).toMatchObject({ stage: 'received', message: { role: 'system' } });
  });

  it('asks the agent for a fix with the compile result attached to the request', async () => {
    const diagnostics = [
      { level: 'error' as const, message: 'Undefined control sequence.', path: 'main.tex' },
    ];
    world.project.willCompile(diagnostics);
    world.agent.will(mainEdit());
    const outcome = await reviewApplied();
    expect(outcome).toMatchObject({ kind: 'fix', result: { message: { kind: 'proposal' } } });
    expect(world.agent.requests[0]).toMatchObject({
      request: {
        kind: 'compile-fix',
        message: { role: 'system', text: COMPILE_FIX_REQUEST },
        diagnostics,
      },
      transcript: [],
    });
    expect(world.project.compileCalls).toBe(1);
  });

  it('drops the review when the conversation was reset during compilation', async () => {
    world.project.willCompile(
      new PendingStep(() => {
        world.resetLater();
        return Promise.resolve([{ level: 'error' as const, message: 'x' }]);
      }),
    );
    await expect(reviewApplied()).rejects.toThrow(RequestSupersededError);
    await Promise.all(world.resets);
    expect(world.agent.requests).toHaveLength(0);
  });
});
