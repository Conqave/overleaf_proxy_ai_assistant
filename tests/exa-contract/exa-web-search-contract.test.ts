import { describe, expect, it } from 'vitest';
import { ExaWebSearch } from '../../src/infrastructure/mcp/exa-web-search';
import { McpClient } from '../../src/infrastructure/mcp/mcp-client';
import { parseEventStreamResult, readExaSearchFixture } from '../support/fake-mcp-server';
import { isRecord } from '../support/guards';
import { TestFixtureError } from '../support/test-errors';

const QUERY = 'Leslie Lamport LaTeX: A Document Preparation System book DOI';
const CLIENT_INFO = { name: 'hans', version: '1' };
const LIVE_TIMEOUT_MS = 60_000;

interface RecordedExchange {
  readonly method: string;
  readonly response: Promise<string>;
}

interface ResultShape {
  readonly content: readonly string[];
  readonly headers: readonly string[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new TestFixtureError(`${name} must be set to check the Exa fixture against live Exa`);
  }
  return value;
}

function headersOf(init: RequestInit | undefined, apiKey: string): Headers {
  const headers = new Headers(init?.headers);
  headers.set('x-api-key', apiKey);
  return headers;
}

function methodOf(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new TestFixtureError('the MCP client posts JSON text');
  const message: unknown = JSON.parse(init.body);
  if (!isRecord(message) || typeof message.method !== 'string') {
    throw new TestFixtureError('the MCP client posts no method');
  }
  return message.method;
}

function recordingFetch(exchanges: RecordedExchange[], apiKey: string): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, { ...init, headers: headersOf(init, apiKey) });
    exchanges.push({ method: methodOf(init), response: response.clone().text() });
    return response;
  };
}

function shapeOf(result: Readonly<Record<string, unknown>>): ResultShape {
  const content: unknown = result.content;
  if (!Array.isArray(content)) throw new TestFixtureError('the Exa result has no content list');
  const items = content.map((item: unknown) => {
    if (!isRecord(item) || typeof item.text !== 'string') {
      throw new TestFixtureError('the Exa result holds an item without text');
    }
    return { fields: Object.keys(item).sort().join(','), text: item.text };
  });
  return {
    content: [...new Set(items.map(({ fields }) => fields))],
    headers: [
      ...new Set(
        items.flatMap(({ text }) => text.split(/\n+---\n+(?=Title: )/).map(headerNamesOf)),
      ),
    ],
  };
}

function headerNamesOf(entry: string): string {
  const lines = entry.trim().split('\n');
  const highlights = lines.indexOf('Highlights:');
  const header = highlights === -1 ? lines : lines.slice(0, highlights);
  return header.map((line) => line.slice(0, line.indexOf(':'))).join(',');
}

describe('Exa web search fixture', () => {
  it(
    'still has the shape live Exa answers a search with',
    async () => {
      const exchanges: RecordedExchange[] = [];
      const search = new ExaWebSearch(
        new McpClient(
          requireEnv('EXA_CONTRACT_URL'),
          CLIENT_INFO,
          recordingFetch(exchanges, requireEnv('EXA_CONTRACT_API_KEY')),
        ),
      );
      const results = await search.search(QUERY, new AbortController().signal);
      expect(results.length).toBeGreaterThan(0);
      const call = exchanges.find(({ method }) => method === 'tools/call');
      if (call === undefined) throw new TestFixtureError('the search made no tools/call request');
      const live = parseEventStreamResult(await call.response, 'the live Exa answer');
      expect(shapeOf(live)).toEqual(shapeOf(readExaSearchFixture()));
    },
    LIVE_TIMEOUT_MS,
  );
});
