import { WEB_SEARCH_LIMITS, type WebSearchResult } from '../../domain/web-search';
import type { CancellationSignal } from '../../ports/cancellation';
import {
  WebSearchContractError,
  WebSearchRateLimitedError,
  WebSearchRejectedError,
  WebSearchTimeoutError,
  WebSearchUnavailableError,
} from '../../ports/errors';
import type { WebSearchPort } from '../../ports/web-search-port';
import { withDeadline } from '../deadline';
import { formatDuration } from '../duration';
import { parseExaSearchResults } from './exa-search-results';
import {
  McpContractError,
  McpHttpError,
  McpRequestError,
  McpUnreachableError,
  type McpClient,
  type McpToolResult,
} from './mcp-client';

const EXA_SEARCH_TOOL = 'web_search_exa';
export const EXA_SEARCH_TIMEOUT_MS = 30_000;
const MAX_REFUSAL_CHARS = 300;
const SHORTENED_MARK = '…';
const FREE_RATE_LIMIT_ANSWER = "You've hit Exa's free MCP rate limit.";

export class ExaWebSearch implements WebSearchPort {
  constructor(private readonly client: McpClient) {}

  async search(query: string, signal: CancellationSignal): Promise<readonly WebSearchResult[]> {
    const result = await withDeadline(
      EXA_SEARCH_TIMEOUT_MS,
      () =>
        new WebSearchTimeoutError(
          `Exa did not answer the web search within ${formatDuration(EXA_SEARCH_TIMEOUT_MS)}.`,
        ),
      [signal],
      (deadline) => this.callSearch(query, deadline),
    );
    if (result.isError) {
      throw new WebSearchRejectedError(
        `Exa refused the web search: ${quoteRefusal(result.texts.join(' '))}`,
      );
    }
    if (result.texts[0]?.startsWith(FREE_RATE_LIMIT_ANSWER) === true) {
      throw new WebSearchRateLimitedError(
        "Exa's free search limit is reached; try again later or configure an Exa API key.",
      );
    }
    return parseExaSearchResults(result.texts);
  }

  private async callSearch(query: string, deadline: AbortSignal): Promise<McpToolResult> {
    const args = { query, objective: query, numResults: WEB_SEARCH_LIMITS.maxResults };
    try {
      return await this.client.callTool(EXA_SEARCH_TOOL, args, deadline);
    } catch (error) {
      if (error instanceof McpUnreachableError || error instanceof McpHttpError) {
        throw new WebSearchUnavailableError(`Exa web search is unavailable: ${error.message}.`, {
          cause: error,
        });
      }
      if (error instanceof McpContractError || error instanceof McpRequestError) {
        throw new WebSearchContractError(`Exa web search broke its contract: ${error.message}.`, {
          cause: error,
        });
      }
      throw error;
    }
  }
}

function quoteRefusal(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_REFUSAL_CHARS) return JSON.stringify(flat);
  return JSON.stringify(
    `${flat.slice(0, MAX_REFUSAL_CHARS - SHORTENED_MARK.length)}${SHORTENED_MARK}`,
  );
}
