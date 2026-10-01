import { afterEach, describe, expect, it } from 'vitest';
import {
  OverleafStore,
  OverleafStoreContractError,
  StoreKey,
} from '../../../src/infrastructure/overleaf/overleaf-store';
import { FakeOverleafStore } from '../../support/fake-overleaf-store';

const install = (store: unknown): void => {
  Object.assign(window, { overleaf: { unstable: { store } } });
};
const neverAborted = (): AbortSignal => new AbortController().signal;

afterEach(() => {
  Reflect.deleteProperty(window, 'overleaf');
});

describe('OverleafStore', () => {
  it.each([
    ['is missing', undefined],
    ['has no watch function', { get: () => null }],
  ])('refuses a store that %s', (_, store) => {
    install(store);
    expect(() => OverleafStore.fromWindow(window)).toThrow(OverleafStoreContractError);
  });

  it('rejects values of the wrong type', () => {
    install(new FakeOverleafStore({ 'editor.open_doc_id': 7 }));
    const store = OverleafStore.fromWindow(window);
    expect(() => store.getString(StoreKey.OpenDocId)).toThrow(OverleafStoreContractError);
    expect(() => store.getBoolean(StoreKey.Opening)).toThrow(OverleafStoreContractError);
  });

  it('waits until a watched value satisfies the condition, then stops watching', async () => {
    const fake = new FakeOverleafStore({ 'editor.opening': true });
    install(fake);
    const store = OverleafStore.fromWindow(window);
    const done = store.waitUntil(
      [StoreKey.Opening],
      () => !store.getBoolean(StoreKey.Opening),
      neverAborted(),
    );
    fake.set('editor.opening', false);
    await expect(done).resolves.toBe(true);
    expect(fake.watcherCount).toBe(0);
  });

  it('gives up when the signal aborts, then stops watching', async () => {
    const fake = new FakeOverleafStore({ 'editor.opening': true });
    install(fake);
    const store = OverleafStore.fromWindow(window);
    const controller = new AbortController();
    const done = store.waitUntil([StoreKey.Opening], () => false, controller.signal);
    controller.abort();
    await expect(done).resolves.toBe(false);
    expect(fake.watcherCount).toBe(0);
  });

  it('passes on an error of the condition instead of waiting forever', async () => {
    const fake = new FakeOverleafStore({ 'editor.opening': 'yes' });
    install(fake);
    const store = OverleafStore.fromWindow(window);
    const done = store.waitUntil(
      [StoreKey.Opening],
      () => store.getBoolean(StoreKey.Opening),
      neverAborted(),
    );
    await expect(done).rejects.toThrow(OverleafStoreContractError);
    expect(fake.watcherCount).toBe(0);
  });

  it('rejects a watch without an unsubscribe function', async () => {
    install({ get: () => false, watch: () => undefined });
    const store = OverleafStore.fromWindow(window);
    await expect(store.waitUntil([StoreKey.Opening], () => false, neverAborted())).rejects.toThrow(
      OverleafStoreContractError,
    );
  });
});
