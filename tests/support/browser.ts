import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { inject } from 'vitest';
import type { FakeOllama } from './fake-ollama';
import type { FakeFolder, FakeOverleafIde } from './fake-overleaf';

const FIXTURE_HTML = readFileSync(
  new URL('../fixtures/overleaf-editor.html', import.meta.url),
  'utf8',
);

export interface Browser {
  window: JSDOM['window'];
  document: Document;
  ollama: FakeOllama;
  consoleErrors: string[];
  pageErrors: Error[];
  expectsConsoleErrors: boolean;
  inject(source: string): void;
  loadOverleaf(rootFolder?: FakeFolder, fileTexts?: ReadonlyMap<string, string>): FakeOverleafIde;
  close(): void;
}

export function openBrowser(ollama: FakeOllama, indexedDB: Pick<IDBFactory, 'open'>): Browser {
  const consoleErrors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  });
  const pageErrors: Error[] = [];
  virtualConsole.on('jsdomError', (error) => {
    pageErrors.push(error);
  });
  virtualConsole.forwardTo(console, { jsdomErrors: 'none' });
  const dom = new JSDOM(FIXTURE_HTML, {
    url: 'http://overleaf.test/project/1',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const window = dom.window;
  let ide: FakeOverleafIde | null = null;
  Object.assign(window, { fetch: ollama.fetch, Response, structuredClone, indexedDB });
  Object.assign(window.Range.prototype, {
    getClientRects: () => [],
  });
  Object.assign(window.HTMLElement.prototype, {
    setPointerCapture: () => undefined,
  });
  return {
    expectsConsoleErrors: false,
    window,
    document: window.document,
    ollama,
    consoleErrors,
    pageErrors,
    inject(source) {
      window.eval(source);
    },
    loadOverleaf(rootFolder, fileTexts) {
      window.eval(inject('fakeOverleafScript'));
      ide = window.fakeOverleaf.load(rootFolder, fileTexts);
      return ide;
    },
    close() {
      ide?.destroy();
      window.close();
    },
  };
}
