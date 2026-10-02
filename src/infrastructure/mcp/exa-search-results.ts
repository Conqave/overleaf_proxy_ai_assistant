import { InvalidWebSearchResultError } from '../../domain/errors';
import { createWebSearchResult, type WebSearchResult } from '../../domain/web-search';
import { WebSearchContractError } from '../../ports/errors';

const ENTRY_SEPARATOR = /\n+---\n+(?=Title: )/;
const HEADER_LINE = /^([A-Za-z][A-Za-z ]*): ?(.*)$/;
const HIGHLIGHTS_LINE = 'Highlights:';
const NOT_AVAILABLE = 'N/A';
const BLANK_LINES = /\n{3,}/g;
const EXCERPT_CHARS = 80;

export function parseExaSearchResults(texts: readonly string[]): readonly WebSearchResult[] {
  const text = texts.join('\n\n').trim();
  if (!text.startsWith('Title: ')) {
    throw new WebSearchContractError(
      `Exa answered without search results: ${JSON.stringify(text.slice(0, EXCERPT_CHARS))}`,
    );
  }
  return text.split(ENTRY_SEPARATOR).map(parseEntry);
}

function parseEntry(entry: string): WebSearchResult {
  const lines = entry.split('\n');
  const highlights = lines.indexOf(HIGHLIGHTS_LINE);
  const header = highlights === -1 ? lines : lines.slice(0, highlights);
  const snippet = highlights === -1 ? '' : lines.slice(highlights + 1).join('\n');
  const fields = parseHeader(header);
  const published = fields.get('Published');
  try {
    return createWebSearchResult({
      title: requireField(fields, 'Title'),
      url: requireField(fields, 'URL'),
      snippet: snippet.replace(BLANK_LINES, '\n\n'),
      ...(published === undefined || published === NOT_AVAILABLE ? {} : { published }),
    });
  } catch (error) {
    if (!(error instanceof InvalidWebSearchResultError)) throw error;
    throw new WebSearchContractError(`Exa sent an invalid search result: ${error.message}`, {
      cause: error,
    });
  }
}

function parseHeader(lines: readonly string[]): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = HEADER_LINE.exec(line);
    const name = match?.[1];
    const value = match?.[2];
    if (name === undefined || value === undefined) {
      throw new WebSearchContractError(
        `Exa sent a search result with the unexpected line ${JSON.stringify(line.slice(0, EXCERPT_CHARS))}`,
      );
    }
    fields.set(name, value.trim());
  }
  return fields;
}

function requireField(fields: ReadonlyMap<string, string>, name: string): string {
  const value = fields.get(name);
  if (value === undefined)
    throw new WebSearchContractError(`Exa sent a search result without ${name}`);
  return value;
}
