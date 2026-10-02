import { describe, expect, it } from 'vitest';
import { InvalidWebSearchResultError } from '../../../src/domain/errors';
import {
  createWebSearchOutcome,
  createWebSearchResult,
  failWebSearch,
  reportWebSearchResults,
  WEB_SEARCH_DENIED,
  WEB_SEARCH_LIMITS,
  type WebSearchOutcome,
} from '../../../src/domain/web-search';
import { TestFixtureError } from '../../support/test-errors';

const RESULT = { title: ' A book ', url: 'https://example.org/a?b=1#c', snippet: ' text \n' };

describe('createWebSearchResult', () => {
  it('keeps a result with trimmed title, snippet and date', () => {
    expect(createWebSearchResult({ ...RESULT, published: ' 1994 ' })).toEqual({
      title: 'A book',
      url: 'https://example.org/a?b=1#c',
      snippet: 'text',
      published: '1994',
    });
    expect(createWebSearchResult(RESULT)).not.toHaveProperty('published');
  });

  it.each([
    ['an empty title', { ...RESULT, title: ' ' }, 'has no title'],
    ['a relative address', { ...RESULT, url: '/a' }, 'not an absolute http or https address'],
    ['a script address', { ...RESULT, url: 'javascript:alert(1)' }, 'not an absolute http'],
    ['an address without host', { ...RESULT, url: 'https:///a' }, 'not an absolute http'],
    ['an address with spaces', { ...RESULT, url: 'https://a.org/x y' }, 'not an absolute http'],
    ['an empty date', { ...RESULT, published: ' ' }, 'empty publication date'],
  ])('rejects %s', (_name, input, problem) => {
    expect(() => createWebSearchResult(input)).toThrow(InvalidWebSearchResultError);
    expect(() => createWebSearchResult(input)).toThrow(problem);
  });
});

describe('reportWebSearchResults', () => {
  const result = (index: number, snippetChars: number) => ({
    title: `Result ${String(index)}`,
    url: `https://example.org/${String(index)}`,
    snippet: 's'.repeat(snippetChars),
  });
  const charsOf = (outcome: WebSearchOutcome): number => {
    if (outcome.status !== 'found') throw new TestFixtureError('no results');
    return outcome.results.reduce(
      (total, { title, url, snippet }) => total + title.length + url.length + snippet.length,
      0,
    );
  };

  it('keeps results that fit as they are', () => {
    const results = [result(1, 100), result(2, 200)];
    expect(reportWebSearchResults(results)).toEqual({
      status: 'found',
      results,
      truncated: false,
    });
  });

  it('keeps at most the first five results', () => {
    const outcome = reportWebSearchResults(Array.from({ length: 7 }, (_, i) => result(i, 10)));
    expect(outcome).toMatchObject({ status: 'found', truncated: true });
    expect(outcome.status === 'found' && outcome.results.map(({ title }) => title)).toEqual([
      'Result 0',
      'Result 1',
      'Result 2',
      'Result 3',
      'Result 4',
    ]);
  });

  it('shortens the longest excerpts to the character limit and marks them', () => {
    const outcome = reportWebSearchResults([result(1, 100), result(2, 5_000), result(3, 3_000)]);
    expect(outcome).toMatchObject({ status: 'found', truncated: true });
    expect(charsOf(outcome)).toBeLessThanOrEqual(WEB_SEARCH_LIMITS.maxResultChars);
    expect(charsOf(outcome)).toBeGreaterThan(WEB_SEARCH_LIMITS.maxResultChars - 10);
    if (outcome.status !== 'found') throw new TestFixtureError('no results');
    const [short, long, middle] = outcome.results;
    expect(short?.snippet).toBe('s'.repeat(100));
    expect(long?.snippet).toMatch(/^s+…$/);
    expect(middle?.snippet.length).toBe(long?.snippet.length);
  });

  it('reports a search without results', () => {
    expect(reportWebSearchResults([])).toEqual({ status: 'found', results: [], truncated: false });
  });
});

describe('web search outcomes', () => {
  it('records a denial and a failure with its problem', () => {
    expect(WEB_SEARCH_DENIED).toEqual({ status: 'denied' });
    expect(failWebSearch(' Exa is unavailable. ')).toEqual({
      status: 'failed',
      problem: 'Exa is unavailable.',
    });
    expect(() => failWebSearch(' ')).toThrow(InvalidWebSearchResultError);
  });

  it.each<[string, WebSearchOutcome, string]>([
    [
      'too many results',
      {
        status: 'found',
        results: Array.from({ length: 6 }, () => RESULT),
        truncated: false,
      },
      'at most 5 results',
    ],
    [
      'results over the character limit',
      {
        status: 'found',
        results: [{ ...RESULT, snippet: 'x'.repeat(WEB_SEARCH_LIMITS.maxResultChars) }],
        truncated: false,
      },
      'at most 4000 characters',
    ],
    [
      'a result with a script address',
      { status: 'found', results: [{ ...RESULT, url: 'javascript:x' }], truncated: false },
      'not an absolute http',
    ],
  ])('rejects a stored outcome with %s', (_name, outcome, problem) => {
    expect(() => createWebSearchOutcome(outcome)).toThrow(InvalidWebSearchResultError);
    expect(() => createWebSearchOutcome(outcome)).toThrow(problem);
  });
});
