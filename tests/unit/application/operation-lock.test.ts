import { describe, expect, it } from 'vitest';
import { RequestInProgressError } from '../../../src/application/errors';
import { OperationLock } from '../../../src/application/operation-lock';
import { InvariantViolation } from '../../../src/domain/errors';

describe('OperationLock', () => {
  it('runs one operation at a time and reports when it is busy', async () => {
    const lock = new OperationLock();
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
    const lock = new OperationLock();
    const failure = new InvariantViolation('broken');
    await expect(lock.run(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(lock.isBusy).toBe(false);
  });

  it('asserts that a step runs inside an operation', async () => {
    const lock = new OperationLock();
    expect(() => {
      lock.assertHeld();
    }).toThrow(InvariantViolation);
    await lock.run(() => {
      lock.assertHeld();
      return Promise.resolve();
    });
  });
});
