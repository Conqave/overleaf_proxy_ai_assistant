import { readFileSync } from 'node:fs';
import type { EditorView } from '@codemirror/view';
import { JSDOM } from 'jsdom';
import { inject } from 'vitest';
import { FakeOllama } from './fake-ollama';

export const FIXTURE_HTML = readFileSync(
  new URL('../fixtures/overleaf-editor.html', import.meta.url),
  'utf8',
);

export interface Browser {
  dom: JSDOM;
  window: JSDOM['window'];
  document: Document;
  ollama: FakeOllama;
  inject(source: string): void;
  openEditor(text?: string): EditorView;
  settle(): Promise<void>;
}

export function openBrowser(
  options: { html?: string; ollama?: FakeOllama; storage?: Record<string, string> } = {},
): Browser {
  const dom = new JSDOM(options.html ?? FIXTURE_HTML, {
    url: 'http://overleaf.test/project/1',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const window = dom.window;
  const ollama = options.ollama ?? new FakeOllama();
  for (const [key, value] of Object.entries(options.storage ?? {})) {
    window.localStorage.setItem(key, value);
  }
  Object.assign(window, { fetch: ollama.fetch, Response });
  let overleafLoaded = false;
  return {
    dom,
    window,
    document: window.document,
    ollama,
    inject(source) {
      window.eval(source);
    },
    openEditor(text) {
      if (!overleafLoaded) window.eval(inject('fakeOverleafScript'));
      overleafLoaded = true;
      return (window as unknown as Window).fakeOverleaf.open(text);
    },
    async settle() {
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

export function editorLines(view: EditorView): string[] {
  return view.state.doc.toJSON();
}
