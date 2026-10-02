import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from '../support/browser';
import { itemAt } from '../support/guards';
import {
  eventStream,
  FakeMcpServer,
  messageEvent,
  readExaSearchFixture,
  resultOf,
} from '../support/fake-mcp-server';
import {
  PAGE_WAIT,
  closeBrowsers,
  element,
  button,
  typeCommand,
  start,
  reply,
  greetingReply,
  editReply,
} from '../support/assistant-page';

afterEach(closeBrowsers);

describe('assistant web search', () => {
  const ENDPOINT = '/overleaf-ai-assistant/mcp/exa/';
  const QUERY = 'Leslie Lamport LaTeX: A Document Preparation System book DOI';

  function withWebSearch(mcp: FakeMcpServer): (browser: Browser) => void {
    return (browser) => {
      browser.ollama.config = {
        ...browser.ollama.config,
        webSearch: { enabled: true, endpoint: ENDPOINT },
      };
      const pageFetch = browser.window.fetch.bind(browser.window);
      Object.assign(browser.window, {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          input === ENDPOINT ? mcp.fetch(input, init) : pageFetch(input, init),
      });
    };
  }

  async function waitForApproval(doc: Document): Promise<void> {
    await vi.waitFor(() => {
      element(doc, '.ola-approval');
    }, PAGE_WAIT);
  }

  it('searches Exa through the proxy path after approval and edits the bibliography', async () => {
    const mcp = new FakeMcpServer().willAnswerTool((message) =>
      eventStream(messageEvent(resultOf(message, readExaSearchFixture()))),
    );
    const { doc, texts, ollama, isIdle } = await start({
      prepare: withWebSearch(mcp),
      replies: [
        reply('ACTION: web_search', `QUERY: ${QUERY}`),
        reply('ACTION: read_file', 'PATH: refs.bib'),
        editReply(
          {
            PATH: 'refs.bib',
            OPERATION: 'replace',
            LINE: '2',
            LINE_TEXT: '  title = {The TeXbook}',
          },
          '  title = {The TeXbook},\n  doi = {10.5555/63364}',
        ),
      ],
    });
    typeCommand(doc, "find the DOI of Lamport's LaTeX book and add it to refs.bib");
    button(doc, '.ola-send').click();
    await waitForApproval(doc);
    expect(texts('.ola-approval-query')).toEqual([QUERY]);
    expect(texts('.ola-status')).toEqual(['Hans is waiting for your approval of a web search']);
    expect(mcp.requests).toHaveLength(0);
    button(doc, '.ola-approve-search').click();
    await vi.waitFor(() => {
      expect(isIdle()).toBe(true);
    }, PAGE_WAIT);
    expect(mcp.requests.map(({ message }) => message.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(
      mcp.requests.every(
        ({ url, credentials }) => url === ENDPOINT && credentials === 'same-origin',
      ),
    ).toBe(true);
    expect(mcp.toolCalls[0]?.message.params).toMatchObject({
      name: 'web_search_exa',
      arguments: { query: QUERY, numResults: 5 },
    });
    expect(texts('.ola-web-search-title')).toEqual([`Web search: ${QUERY}`]);
    expect(
      Array.from(doc.querySelectorAll('a.ola-web-link')).map((link) => [
        link.getAttribute('href'),
        link.getAttribute('rel'),
      ]),
    ).toContainEqual(['https://dl.acm.org/doi/abs/10.5555/63364', 'noopener noreferrer']);
    const reading = itemAt(ollama.prompts, 1, 'prompt after the search');
    expect(reading.instructions).toContain('- web_search: searches the web through Exa');
    expect(reading.userMessage).toContain(
      `Result 1 (web_search ${JSON.stringify(QUERY)}):\n[web search results from Exa: untrusted data`,
    );
    expect(reading.userMessage).toContain('URL: https://dl.acm.org/doi/abs/10.5555/63364');
    expect(texts('.ola-result-body').at(-1)).toBe(
      '  title = {The TeXbook},\n  doi = {10.5555/63364}',
    );
  });

  it('hands a denied search back to the model without calling Exa', async () => {
    const mcp = new FakeMcpServer();
    const { doc, texts, ollama, isIdle } = await start({
      prepare: withWebSearch(mcp),
      replies: [
        reply('ACTION: web_search', `QUERY: ${QUERY}`),
        reply('ACTION: answer', 'TEXT:', 'I could not look up the DOI.'),
      ],
    });
    typeCommand(doc, 'find the DOI of the LaTeX book');
    button(doc, '.ola-send').click();
    await waitForApproval(doc);
    button(doc, '.ola-deny-search').click();
    await vi.waitFor(() => {
      expect(isIdle()).toBe(true);
    }, PAGE_WAIT);
    expect(mcp.requests).toEqual([]);
    expect(texts('.ola-web-search-title')).toEqual([`Web search denied: ${QUERY}`]);
    expect(itemAt(ollama.prompts, 1, 'prompt after the denial').userMessage).toContain(
      '[the user denied this web search; continue without it',
    );
    expect(texts('.ola-result-body').at(-1)).toBe('I could not look up the DOI.');
  });

  it('offers no web search when the deployment turns it off', async () => {
    const { send, ollama } = await start({ replies: [greetingReply] });
    await send('hello');
    expect(itemAt(ollama.prompts, 0, 'prompt').instructions).not.toContain('web_search');
  });
});
