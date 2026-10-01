import { InvariantViolation } from '../domain/errors';
import { RequestInProgressError } from './errors';

export class OperationLock {
  private busy = false;
  private readonly listeners: ((busy: boolean) => void)[] = [];

  get isBusy(): boolean {
    return this.busy;
  }

  onChange(listener: (busy: boolean) => void): void {
    this.listeners.push(listener);
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new RequestInProgressError();
    this.setBusy(true);
    try {
      return await operation();
    } finally {
      this.setBusy(false);
    }
  }

  assertHeld(): void {
    if (!this.busy) throw new InvariantViolation('this step runs only inside an operation');
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    for (const listener of this.listeners) listener(busy);
  }
}
