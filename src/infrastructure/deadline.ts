import { InvariantViolation } from '../domain/errors';
import type { CancellationSignal } from '../ports/cancellation';

export async function withDeadline<T>(
  timeoutMs: number,
  createTimeoutError: () => Error,
  cancels: readonly CancellationSignal[],
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(createTimeoutError());
  }, timeoutMs);
  const forwards = cancels.map((cancel) => forwardCancellation(cancel, deadline));
  try {
    return await run(deadline.signal);
  } finally {
    clearTimeout(timer);
    for (const stop of forwards) stop();
  }
}

export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
  signal.throwIfAborted();
}

export function throwAbortReason(signal: AbortSignal): never {
  signal.throwIfAborted();
  throw new InvariantViolation('a wait ended although its signal was not aborted');
}

function forwardCancellation(cancel: CancellationSignal, deadline: AbortController): () => void {
  const forward = (): void => {
    deadline.abort(cancel.reason);
  };
  if (cancel.aborted) forward();
  cancel.addEventListener('abort', forward);
  return () => {
    cancel.removeEventListener('abort', forward);
  };
}
