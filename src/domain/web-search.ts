import { InvalidWebSearchResultError } from './errors';

export const WEB_SEARCH_LIMITS = {
  maxResults: 5,
  maxResultChars: 4_000,
  queryChars: { min: 3, max: 200 },
} as const;

const SHORTENED_MARK = '…';

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly published?: string;
}

export const WebSearchStatus = {
  Found: 'found',
  Denied: 'denied',
  Failed: 'failed',
} as const;
export type WebSearchStatus = (typeof WebSearchStatus)[keyof typeof WebSearchStatus];

export type WebSearchOutcome =
  | {
      readonly status: typeof WebSearchStatus.Found;
      readonly results: readonly WebSearchResult[];
      readonly truncated: boolean;
    }
  | { readonly status: typeof WebSearchStatus.Denied }
  | { readonly status: typeof WebSearchStatus.Failed; readonly problem: string };

const WEB_URL = /^https?:\/\/[^\s/?#]+\S*$/i;

export function createWebSearchResult({
  title,
  url,
  snippet,
  published,
}: WebSearchResult): WebSearchResult {
  const shownTitle = title.trim();
  if (shownTitle === '')
    throw new InvalidWebSearchResultError(`the result for ${url} has no title`);
  if (!WEB_URL.test(url)) {
    throw new InvalidWebSearchResultError(
      `${JSON.stringify(url)} is not an absolute http or https address`,
    );
  }
  const result = { title: shownTitle, url, snippet: snippet.trim() };
  if (published === undefined) return Object.freeze(result);
  if (published.trim() === '') {
    throw new InvalidWebSearchResultError(`the result for ${url} has an empty publication date`);
  }
  return Object.freeze({ ...result, published: published.trim() });
}

export function reportWebSearchResults(results: readonly WebSearchResult[]): WebSearchOutcome {
  const kept = fitIntoLimit(results.slice(0, WEB_SEARCH_LIMITS.maxResults));
  const truncated =
    kept.length < results.length ||
    kept.some((result, index) => result.snippet !== results[index]?.snippet);
  return createWebSearchOutcome({ status: WebSearchStatus.Found, results: kept, truncated });
}

export const WEB_SEARCH_DENIED: WebSearchOutcome = Object.freeze({
  status: WebSearchStatus.Denied,
});

export function failWebSearch(problem: string): WebSearchOutcome {
  return createWebSearchOutcome({ status: WebSearchStatus.Failed, problem: problem.trim() });
}

export function createWebSearchOutcome(outcome: WebSearchOutcome): WebSearchOutcome {
  switch (outcome.status) {
    case WebSearchStatus.Found: {
      const results = outcome.results.map(createWebSearchResult);
      if (results.length > WEB_SEARCH_LIMITS.maxResults) {
        throw new InvalidWebSearchResultError(
          `a web search keeps at most ${String(WEB_SEARCH_LIMITS.maxResults)} results, not ${String(results.length)}`,
        );
      }
      const chars = sum(results.map(countChars));
      if (chars > WEB_SEARCH_LIMITS.maxResultChars) {
        throw new InvalidWebSearchResultError(
          `web search results keep at most ${String(WEB_SEARCH_LIMITS.maxResultChars)} characters, not ${String(chars)}`,
        );
      }
      return Object.freeze({ ...outcome, results: Object.freeze(results) });
    }
    case WebSearchStatus.Denied:
      return WEB_SEARCH_DENIED;
    case WebSearchStatus.Failed:
      if (outcome.problem.trim() === '') {
        throw new InvalidWebSearchResultError('a failed web search names its problem');
      }
      return Object.freeze({ ...outcome });
  }
}

function fitIntoLimit(results: readonly WebSearchResult[]): readonly WebSearchResult[] {
  const fitting = [...results];
  while (sum(fitting.map(countHeaderChars)) > WEB_SEARCH_LIMITS.maxResultChars) fitting.pop();
  const snippetChars = WEB_SEARCH_LIMITS.maxResultChars - sum(fitting.map(countHeaderChars));
  const level = findSnippetLevel(
    fitting.map(({ snippet }) => snippet.length),
    snippetChars,
  );
  return fitting.map((result) => shortenSnippet(result, level));
}

function findSnippetLevel(lengths: readonly number[], budget: number): number {
  const sorted = [...lengths].sort((a, b) => a - b);
  let remaining = budget;
  for (const [index, length] of sorted.entries()) {
    const share = Math.floor(remaining / (sorted.length - index));
    if (length > share) return share;
    remaining -= length;
  }
  return Number.POSITIVE_INFINITY;
}

function shortenSnippet(result: WebSearchResult, maxChars: number): WebSearchResult {
  if (result.snippet.length <= maxChars) return result;
  const kept = result.snippet.slice(0, Math.max(0, maxChars - SHORTENED_MARK.length)).trimEnd();
  return { ...result, snippet: kept === '' ? '' : `${kept}${SHORTENED_MARK}` };
}

function countHeaderChars({ title, url, published }: WebSearchResult): number {
  return title.length + url.length + (published === undefined ? 0 : published.length);
}

function countChars(result: WebSearchResult): number {
  return countHeaderChars(result) + result.snippet.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
