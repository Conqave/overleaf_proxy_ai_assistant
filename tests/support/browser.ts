import { readFileSync } from 'node:fs';
import type { EditorView } from '@codemirror/view';
import { JSDOM, VirtualConsole } from 'jsdom';
import { inject } from 'vitest';
import type { FakeOllama } from './fake-ollama';

const FIXTURE_HTML = readFileSync(
  new URL('../fixtures/overleaf-editor.html', import.meta.url),
  'utf8',
);

export interface Browser {
  window: JSDOM['window'];
  document: Document;
  ollama: FakeOllama;
  consoleErrors: string[];
  inject(source: string): void;
  openEditor(text?: string): EditorView;
  close(): void;
}

export function openBrowser(ollama: FakeOllama): Browser {
  const consoleErrors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  });
  virtualConsole.forwardTo(console);
  const dom = new JSDOM(FIXTURE_HTML, {
    url: 'http://overleaf.test/project/1',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const window = dom.window;
  Object.assign(window, { fetch: ollama.fetch, Response });
  let overleafLoaded = false;
  return {
    window,
    document: window.document,
    ollama,
    consoleErrors,
    inject(source) {
      window.eval(source);
    },
    openEditor(text) {
      if (!overleafLoaded) window.eval(inject('fakeOverleafScript'));
      overleafLoaded = true;
      return (window as unknown as Window).fakeOverleaf.open(text);
    },
    close() {
      window.close();
    },
  };
}

export function editorLines(view: EditorView): string[] {
  return view.state.doc.toJSON();
}
