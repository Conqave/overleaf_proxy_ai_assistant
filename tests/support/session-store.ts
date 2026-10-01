import type { IDBFactory } from 'fake-indexeddb';
import {
  SESSION_DATABASE,
  SESSION_STORE,
} from '../../src/infrastructure/persistence/indexed-db-session-repository';
import { TestFixtureError } from './test-errors';

export function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new TestFixtureError('the request failed without an error'));
    };
  });
}

export async function readStoredSessions(factory: IDBFactory): Promise<unknown[]> {
  const database = await settled(factory.open(SESSION_DATABASE));
  const records: unknown[] = await settled(
    database.transaction(SESSION_STORE).objectStore(SESSION_STORE).getAll(),
  );
  database.close();
  return records;
}

export async function storeRawSession(
  factory: IDBFactory,
  record: Record<string, unknown>,
): Promise<void> {
  const database = await settled(factory.open(SESSION_DATABASE));
  await settled(
    database.transaction(SESSION_STORE, 'readwrite').objectStore(SESSION_STORE).put(record),
  );
  database.close();
}
