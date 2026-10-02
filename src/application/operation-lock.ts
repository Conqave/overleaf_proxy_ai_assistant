import { InvariantViolation } from '../domain/errors';
import type { CancellationController, CancellationSignal } from '../ports/cancellation';
import { RequestInProgressError } from './errors';

export function ensureNotCancelled(signal: CancellationSignal): void {
  if (signal.aborted) throw signal.reason;
}

interface RunningOperation {
  readonly controller: CancellationController;
  readonly finished: Promise<void>;
}

export class OperationLock {
  private current: RunningOperation | null = null;
  private readonly listeners: ((busy: boolean) => void)[] = [];

  constructor(private readonly createController: () => CancellationController) {}

  onChange(listener: (busy: boolean) => void): void {
    this.listeners.push(listener);
  }

  async run<T>(operation: (signal: CancellationSignal) => Promise<T>): Promise<T> {
    if (this.current !== null) throw new RequestInProgressError();
    const controller = this.createController();
    let finish = (): void => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.setCurrent({ controller, finished });
    try {
      return await operation(controller.signal);
    } finally {
      this.setCurrent(null);
      finish();
    }
  }

  async cancel(reason: Error): Promise<boolean> {
    let cancelled = false;
    while (this.current !== null) {
      const { controller, finished } = this.current;
      controller.abort(reason);
      cancelled = true;
      await finished;
    }
    return cancelled;
  }

  assertHeld(): void {
    if (this.current === null) {
      throw new InvariantViolation('this step runs only inside an operation');
    }
  }

  private setCurrent(operation: RunningOperation | null): void {
    this.current = operation;
    for (const listener of this.listeners) listener(operation !== null);
  }
}
