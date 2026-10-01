import { FakeOverleafIde } from './fake-overleaf';

declare global {
  interface Window {
    fakeOverleaf: { load(): FakeOverleafIde };
  }
}

const DOWNLOAD_URL = /^\/Project\/[^/]+\/doc\/([^/]+)\/download$/;
const HTTP_NOT_FOUND = 404;

window.fakeOverleaf = {
  load() {
    const ide = new FakeOverleafIde(window);
    const pageFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (typeof input !== 'string') return pageFetch(input, init);
      const download = DOWNLOAD_URL.exec(input);
      const docId = download?.[1];
      if (docId === undefined) return pageFetch(input, init);
      if (!ide.hasText(docId)) {
        return Promise.resolve(new Response('missing', { status: HTTP_NOT_FOUND }));
      }
      return Promise.resolve(new Response(ide.textOf(docId)));
    };
    return ide;
  },
};
