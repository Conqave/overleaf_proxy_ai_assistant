import { describe, expect, it } from 'vitest';
import { RequestInProgressError } from '../../../src/application/errors';
import { OperationLock } from '../../../src/application/operation-lock';
import { InvariantViolation } from '../../../src/domain/errors';
import { rejectOnAbort } from '../../support/fakes';

describe('OperationLock', () => {
  it('runs one operation at a time and reports when it is busy', async () => {
    const lock = new OperationLock(() => new AbortController());
    const changes: boolean[] = [];
    lock.onChange((busy) => {
      changes.push(busy);
    });
    const finished = Promise.withResolvers<string>();
    const running = lock.run(() => finished.promise);
    expect(lock.isBusy).toBe(true);
    await expect(lock.run(() => Promise.resolve('second'))).rejects.toThrow(RequestInProgressError);
    finished.resolve('first');
    await expect(running).resolves.toBe('first');
    expect(lock.isBusy).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('frees itself when the operation fails', async () => {
    const lock = new OperationLock(() => new AbortController());
    const failure = new InvariantViolation('broken');
    await expect(lock.run(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(lock.isBusy).toBe(false);
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
    const lock = new OperationLock(() => new AbortController());
    const reason = new RequestInProgressError();
    const running = lock.run(rejectOnAbort);
    lock.cancel(reason);
    await expect(running).rejects.toBe(reason);
    expect(lock.isBusy).toBe(false);
  });

  it('ignores a cancel while nothing runs', () => {
    const lock = new OperationLock(() => new AbortController());
    expect(() => {
      lock.cancel(new RequestInProgressError());
    }).not.toThrow();
  });
});
