import type { ConversationSummarizer, SummaryRequest } from '../../ports/conversation-summarizer';
import { fitIntoContext } from './context-budget';
import { runExchange } from './correction-exchange';
import type { OllamaClient } from './ollama-client';
import { createSummaryExchange } from './summary-protocol';

export class OllamaSummarizer implements ConversationSummarizer {
  constructor(private readonly client: OllamaClient) {}

  async summarize(request: SummaryRequest): Promise<string> {
    return await this.client.withDeadline([request.signal], (deadline) =>
      fitIntoContext(async (promptChars) => {
        const exchange = createSummaryExchange(request, promptChars);
        const { value } = await runExchange(this.client, exchange, deadline);
        return value;
      }),
    );
  }
}
