import { InvalidWebSearchResultError } from './errors';

export const WEB_SEARCH_LIMITS = {
  maxResults: 5,
} as const;

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly published?: string;
}

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
