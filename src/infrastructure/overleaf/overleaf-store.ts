import { NamedError } from '../../domain/errors';

export const StoreKey = {
  Project: 'project',
  OpenDocId: 'editor.open_doc_id',
  Opening: 'editor.opening',
  OpenFile: 'openFile',
  LogEntries: 'pdf.logEntries',
  PdfUrl: 'pdf.url',
  SharedDocument: 'editor.sharejs_doc',
} as const;
export type StoreKey = (typeof StoreKey)[keyof typeof StoreKey];

export interface SharedDocument {
  flush(): void;
  hasBufferedOps(): boolean;
}

interface RawStore {
  get(key: string): unknown;
  watch(key: string, callback: () => void): unknown;
}

export class OverleafStoreContractError extends NamedError {
  constructor(problem: string, options?: { cause?: unknown }) {
    super(
      `window.overleaf.unstable.store does not match the expected contract: ${problem}.`,
      options,
    );
  }
}

export class OverleafStore {
  private constructor(private readonly raw: RawStore) {}

  static fromWindow(window: Window): OverleafStore {
    const store = findStore(Reflect.get(window, 'overleaf'));
    if (!isRawStore(store)) {
      throw new OverleafStoreContractError('it is missing or has no get and watch functions');
    }
    return new OverleafStore(store);
  }

  get(key: StoreKey): unknown {
    return this.raw.get(key);
  }

  getString(key: StoreKey): string {
    const value = this.get(key);
    if (typeof value !== 'string') throw new OverleafStoreContractError(`${key} is not a string`);
    return value;
  }

  getBoolean(key: StoreKey): boolean {
    const value = this.get(key);
    if (typeof value !== 'boolean') throw new OverleafStoreContractError(`${key} is not a boolean`);
    return value;
  }

  getSharedDocument(): SharedDocument | null {
    const value = this.get(StoreKey.SharedDocument);
    if (value === null) return null;
    if (!isSharedDocument(value)) {
      throw new OverleafStoreContractError(
        `${StoreKey.SharedDocument} is neither null nor a document with flush and hasBufferedOps`,
      );
    }
    return value;
  }

  async waitUntil(
    keys: readonly StoreKey[],
    isDone: () => boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    const finished = Promise.withResolvers<boolean>();
    const check = (): void => {
      void Promise.resolve()
        .then(isDone)
        .then((done) => {
          if (done) finished.resolve(true);
        }, finished.reject);
    };
    const abort = (): void => {
      finished.resolve(false);
    };
    signal.addEventListener('abort', abort);
    const unsubscribers: (() => void)[] = [];
    try {
      for (const key of keys) unsubscribers.push(this.watch(key, check));
      check();
      if (signal.aborted) abort();
      return await finished.promise;
    } finally {
      signal.removeEventListener('abort', abort);
      for (const unsubscribe of unsubscribers) unsubscribe();
    }
  }

  watch(key: StoreKey, callback: () => void): () => void {
    const unsubscribe = this.raw.watch(key, callback);
    if (!isUnsubscribe(unsubscribe)) {
      throw new OverleafStoreContractError(`watch(${key}) returned no unsubscribe function`);
    }
    return unsubscribe;
  }
}

function findStore(overleaf: unknown): unknown {
  if (typeof overleaf !== 'object' || overleaf === null || !('unstable' in overleaf)) {
    return undefined;
  }
  const { unstable } = overleaf;
  if (typeof unstable !== 'object' || unstable === null || !('store' in unstable)) {
    return undefined;
  }
  return unstable.store;
}

function isRawStore(value: unknown): value is RawStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    'get' in value &&
    typeof value.get === 'function' &&
    'watch' in value &&
    typeof value.watch === 'function'
  );
}

function isUnsubscribe(value: unknown): value is () => void {
  return typeof value === 'function';
}

function isSharedDocument(value: unknown): value is SharedDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    'flush' in value &&
    typeof value.flush === 'function' &&
    'hasBufferedOps' in value &&
    typeof value.hasBufferedOps === 'function'
  );
}
