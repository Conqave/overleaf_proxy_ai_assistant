import { describe, expect, it } from 'vitest';
import { RequestInProgressError } from '../../../src/application/errors';
import { OperationLock } from '../../../src/application/operation-lock';
import { InvariantViolation } from '../../../src/domain/errors';
import type { CancellationSignal } from '../../../src/ports/cancellation';
import { rejectOnAbort } from '../../support/fakes';

function observedLock(): { lock: OperationLock; changes: boolean[] } {
  const lock = new OperationLock(() => new AbortController());
  const changes: boolean[] = [];
  lock.onChange((busy) => {
    changes.push(busy);
  });
  return { lock, changes };
}

describe('OperationLock', () => {
  it('runs one operation at a time and reports when it is busy', async () => {
    const { lock, changes } = observedLock();
    const finished = Promise.withResolvers<string>();
    const running = lock.run(() => finished.promise);
    expect(changes).toEqual([true]);
    await expect(lock.run(() => Promise.resolve('second'))).rejects.toThrow(RequestInProgressError);
    finished.resolve('first');
    await expect(running).resolves.toBe('first');
    expect(changes).toEqual([true, false]);
  });

  it('frees itself when the operation fails', async () => {
    const { lock, changes } = observedLock();
    const failure = new InvariantViolation('broken');
    await expect(lock.run(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(changes).toEqual([true, false]);
  });

  it('asserts that a step runs inside an operation', async () => {
    const lock = new OperationLock(() => new AbortController());
    expect(() => {
      lock.assertHeld();
    }).toThrow(InvariantViolation);
    await lock.run(() => {
      lock.assertHeld();
      return Promise.resolve();
    });
  });

  it('cancels the running operation and runs the new one once it has ended', async () => {
    const { lock, changes } = observedLock();
    const reason = new RequestInProgressError();
    const order: string[] = [];
    const running = lock.run(async (signal) => {
      try {
        await rejectOnAbort(signal);
      } finally {
        order.push('cancelled ended');
      }
    });
    const superseding = lock.supersede(reason, () => {
      order.push('new started');
      return Promise.resolve('new');
    });
    await expect(running).rejects.toBe(reason);
    await expect(superseding).resolves.toBe('new');
    expect(order).toEqual(['cancelled ended', 'new started']);
    expect(changes).toEqual([true, false, true, false]);
  });

  it('waits for a cancelled operation that ignores its signal', async () => {
    const lock = new OperationLock(() => new AbortController());
    const finished = Promise.withResolvers<undefined>();
    const signals: CancellationSignal[] = [];
    const running = lock.run(async (signal) => {
      signals.push(signal);
      await finished.promise;
    });
    let isSuperseded = false;
    const superseding = lock
      .supersede(new RequestInProgressError(), () => Promise.resolve())
      .then(() => {
        isSuperseded = true;
      });
    await Promise.resolve();
    expect(signals.map(({ aborted }) => aborted)).toEqual([true]);
    expect(isSuperseded).toBe(false);
    finished.resolve(undefined);
    await running;
    await superseding;
    expect(isSuperseded).toBe(true);
  });

  it('runs a superseding operation at once while nothing runs', async () => {
    const lock = new OperationLock(() => new AbortController());
    await expect(
      lock.supersede(new RequestInProgressError(), () => Promise.resolve('only')),
    ).resolves.toBe('only');
  });
});
