import { InvariantViolation } from '../domain/errors';
import type { CancellationController, CancellationSignal } from '../ports/cancellation';
import { RequestInProgressError } from './errors';

export class OperationLock {
  private current: CancellationController | null = null;
  private readonly listeners: ((busy: boolean) => void)[] = [];

  constructor(private readonly createController: () => CancellationController) {}

  onChange(listener: (busy: boolean) => void): void {
    this.listeners.push(listener);
  }

  async run<T>(operation: (signal: CancellationSignal) => Promise<T>): Promise<T> {
    if (this.current !== null) throw new RequestInProgressError();
    const controller = this.createController();
    this.setCurrent(controller);
    try {
      return await operation(controller.signal);
    } finally {
      this.setCurrent(null);
    }
  }

  cancel(reason: Error): void {
    this.current?.abort(reason);
  }

  assertHeld(): void {
    if (this.current === null) {
      throw new InvariantViolation('this step runs only inside an operation');
    }
  }

  private setCurrent(controller: CancellationController | null): void {
    this.current = controller;
    for (const listener of this.listeners) listener(controller !== null);
  }
}
