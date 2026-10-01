export class FakeOverleafStore {
  private readonly values = new Map<string, unknown>();
  private readonly watchers = new Map<string, Set<(value: unknown) => void>>();

  constructor(initial: Record<string, unknown>) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  get(key: string): unknown {
    return this.values.get(key);
  }

  set(key: string, value: unknown): void {
    this.values.set(key, value);
    for (const callback of this.watchersOf(key)) callback(value);
  }

  watch(key: string, callback: (value: unknown) => void): () => void {
    const watchers = this.watchersOf(key);
    watchers.add(callback);
    queueMicrotask(() => {
      if (watchers.has(callback)) callback(this.values.get(key));
    });
    return () => {
      watchers.delete(callback);
    };
  }

  get watcherCount(): number {
    return [...this.watchers.values()].reduce((count, watchers) => count + watchers.size, 0);
  }

  private watchersOf(key: string): Set<(value: unknown) => void> {
    const existing = this.watchers.get(key);
    if (existing !== undefined) return existing;
    const created = new Set<(value: unknown) => void>();
    this.watchers.set(key, created);
    return created;
  }
}
