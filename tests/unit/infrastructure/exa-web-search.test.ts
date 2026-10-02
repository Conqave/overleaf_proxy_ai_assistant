import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXA_SEARCH_TIMEOUT_MS,
  ExaWebSearch,
} from '../../../src/infrastructure/mcp/exa-web-search';
import { McpClient } from '../../../src/infrastructure/mcp/mcp-client';
import {
  WebSearchContractError,
  WebSearchRejectedError,
  WebSearchTimeoutError,
  WebSearchUnavailableError,
} from '../../../src/ports/errors';
import {
  eventStream,
  FakeMcpServer,
  messageEvent,
  readExaSearchFixture,
  resultOf,
  toolResult,
  type McpReply,
} from '../../support/fake-mcp-server';
import { TestFixtureError } from '../../support/test-errors';

const searchOf = (server: FakeMcpServer) =>
  new ExaWebSearch(new McpClient('/mcp', { name: 'hans', version: '1' }, server.fetch));

const search = (server: FakeMcpServer, signal = new AbortController().signal) =>
  searchOf(server).search('Lamport LaTeX book DOI', signal);

const answer =
  (text: string, isError = false): McpReply =>
  (message) =>
    eventStream(messageEvent(resultOf(message, toolResult(text, isError))));

afterEach(() => {
  vi.useRealTimers();
});

describe('ExaWebSearch', () => {
  it('asks Exa for a few results of the query', async () => {
    const server = new FakeMcpServer().willAnswerTool((message) =>
      eventStream(messageEvent(resultOf(message, readExaSearchFixture()))),
    );
    await search(server);
    expect(server.toolCalls[0]?.message.params).toEqual({
      name: 'web_search_exa',
      arguments: {
        query: 'Lamport LaTeX book DOI',
        objective: 'Lamport LaTeX book DOI',
        numResults: 5,
      },
    });
  });

  it('turns the text Exa answers into results with title, address and snippet', async () => {
    const server = new FakeMcpServer().willAnswerTool((message) =>
      eventStream(messageEvent(resultOf(message, readExaSearchFixture()))),
    );
    const results = await search(server);
    expect(results.map(({ title, url }) => ({ title, url }))).toEqual([
      {
        title: 'LATEX : a document preparation system',
        url: 'https://search.worldcat.org/title/12550262',
      },
      {
        title: 'Latex: a document preparation system | Guide books',
        url: 'https://dl.acm.org/doi/abs/10.5555/63364',
      },
      {
        title: 'LaTeX: A Document Preparation System, 2nd Edition | InformIT',
        url: 'https://www.informit.com/store/latex-a-document-preparation-system-9780201529838?ranMID=24808',
      },
    ]);
    expect(results[0]?.snippet).toMatch(/^# LATEX : a document preparation system\n/);
    expect(results[0]?.snippet).toContain('ISBN:');
    expect(results.every((result) => result.published === undefined)).toBe(true);
  });

  it('keeps a publication date and a markdown rule inside the highlights', async () => {
    const text = [
      'Title: First',
      'URL: https://a.example/1',
      'Published: 2026-08-09T00:00:00.000Z',
      'Author: N/A',
      'Highlights:',
      'Before the rule.',
      '',
      '---',
      '',
      'After the rule.',
      '',
      '',
      '',
      'Last line.',
      '',
      '---',
      '',
      'Title: Second',
      'URL: http://b.example/',
      'Published: N/A',
      'Author: Someone',
    ].join('\n');
    const results = await search(new FakeMcpServer().willAnswerTool(answer(text)));
    expect(results).toEqual([
      {
        title: 'First',
        url: 'https://a.example/1',
        published: '2026-08-09T00:00:00.000Z',
        snippet: 'Before the rule.\n\n---\n\nAfter the rule.\n\nLast line.',
      },
      { title: 'Second', url: 'http://b.example/', snippet: '' },
    ]);
  });

  it.each([
    ['text without results', 'No results.', 'answered without search results'],
    ['a result without an address', 'Title: A\nPublished: N/A', 'without URL'],
    ['a script address', 'Title: A\nURL: javascript:alert(1)', 'not an absolute http'],
    [
      'an unknown line in the header',
      'Title: A\nURL: https://a.example\nfree text',
      'unexpected line',
    ],
  ])('rejects %s as a broken contract', async (_name, text, problem) => {
    const failure = search(new FakeMcpServer().willAnswerTool(answer(text)));
    await expect(failure).rejects.toThrow(WebSearchContractError);
    await expect(failure).rejects.toThrow(problem);
  });

  it('reports an error Exa returns as a refused search', async () => {
    const server = new FakeMcpServer().willAnswerTool(answer('Invalid API key.', true));
    await expect(search(server)).rejects.toThrow(
      new WebSearchRejectedError('Exa refused the web search: Invalid API key.'),
    );
  });

  it('reports an unreachable or failing service as unavailable', async () => {
    const failing = new FakeMcpServer().willAnswerTool(() => new Response('', { status: 502 }));
    const failure = search(failing);
    await expect(failure).rejects.toThrow(WebSearchUnavailableError);
    await expect(failure).rejects.toThrow('HTTP 502');
    const offline = new ExaWebSearch(
      new McpClient('/mcp', { name: 'hans', version: '1' }, () =>
        Promise.reject(new TypeError('Failed to fetch')),
      ),
    );
    await expect(offline.search('q', new AbortController().signal)).rejects.toThrow(
      WebSearchUnavailableError,
    );
  });

  it('reports a protocol violation of the service as a broken contract', async () => {
    const server = new FakeMcpServer().willAnswerTool(
      () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
    );
    await expect(search(server)).rejects.toThrow(WebSearchContractError);
  });

  it('gives up after its time limit', async () => {
    vi.useFakeTimers();
    const hanging = new ExaWebSearch(
      new McpClient('/mcp', { name: 'hans', version: '1' }, (_input, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }),
    );
    const failure = hanging.search('q', new AbortController().signal);
    const expectation = expect(failure).rejects.toThrow(
      new WebSearchTimeoutError('Exa did not answer the web search within 30 seconds.'),
    );
    await vi.advanceTimersByTimeAsync(EXA_SEARCH_TIMEOUT_MS);
    await expectation;
  });

  it('stops with the reason of a cancellation', async () => {
    const controller = new AbortController();
    const reason = new TestFixtureError('cancelled');
    controller.abort(reason);
    await expect(search(new FakeMcpServer(), controller.signal)).rejects.toBe(reason);
  });
});
