import { AgentTool, type WebSearchCall } from '../domain/agent-action';
import type { ToolResult } from '../domain/agent-transcript';
import {
  failWebSearch,
  reportWebSearchResults,
  WEB_SEARCH_DENIED,
  type WebSearchOutcome,
} from '../domain/web-search';
import type { CancellationSignal } from '../ports/cancellation';
import { WebSearchError } from '../ports/errors';
import type { WebSearchPort } from '../ports/web-search-port';
import type { AgentProgress } from './agent-progress';
import type { WebSearchApproval } from './web-search-approval';

export class WebSearchTool {
  constructor(
    private readonly deps: {
      search: WebSearchPort;
      approval: WebSearchApproval;
    },
  ) {}

  async run(
    { query }: WebSearchCall,
    requestId: string,
    onProgress: (progress: AgentProgress) => void,
    signal: CancellationSignal,
  ): Promise<ToolResult> {
    const approved = await this.deps.approval.request({ query, requestId }, onProgress, signal);
    return {
      tool: AgentTool.WebSearch,
      outcome: approved ? await this.search(query, onProgress, signal) : WEB_SEARCH_DENIED,
    };
  }

  private async search(
    query: string,
    onProgress: (progress: AgentProgress) => void,
    signal: CancellationSignal,
  ): Promise<WebSearchOutcome> {
    onProgress({ stage: 'searching-web', query });
    try {
      return reportWebSearchResults(await this.deps.search.search(query, signal));
    } catch (error) {
      if (!(error instanceof WebSearchError)) throw error;
      return failWebSearch(error.message);
    }
  }
}
