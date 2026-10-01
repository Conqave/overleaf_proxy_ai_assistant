import { describe, expect, it } from 'vitest';
import { RequestInProgressError } from '../../../src/application/errors';
import { OperationLock } from '../../../src/application/operation-lock';
import { InvariantViolation } from '../../../src/domain/errors';
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

  it('cancels the running operation through its signal', async () => {
    const { lock, changes } = observedLock();
    const reason = new RequestInProgressError();
    const running = lock.run(rejectOnAbort);
    lock.cancel(reason);
    await expect(running).rejects.toBe(reason);
    expect(changes).toEqual([true, false]);
  });

  it('ignores a cancel while nothing runs', () => {
    const lock = new OperationLock(() => new AbortController());
    expect(() => {
      lock.cancel(new RequestInProgressError());
    }).not.toThrow();
  });
});
