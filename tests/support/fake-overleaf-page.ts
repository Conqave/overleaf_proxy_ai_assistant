import { FakeOverleafIde, type FakeFolder } from './fake-overleaf';

declare global {
  interface Window {
    fakeOverleaf: {
      load(rootFolder?: FakeFolder, fileTexts?: ReadonlyMap<string, string>): FakeOverleafIde;
    };
  }
}

const OVERLEAF_URL = /^\/project\//i;

window.fakeOverleaf = {
  load(rootFolder, fileTexts) {
    const ide = new FakeOverleafIde(window, rootFolder, fileTexts);
    const pageFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (typeof input === 'string' && OVERLEAF_URL.test(input)) {
        return ide.server.fetch(input, init);
      }
      return pageFetch(input, init);
    };
    return ide;
  },
};
