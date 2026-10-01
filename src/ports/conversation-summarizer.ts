import type { ConversationSummary, ExchangeMessage } from '../domain/conversation';
import type { CancellationSignal } from './cancellation';

export interface SummaryRequest {
  readonly previous: ConversationSummary | null;
  readonly covered: readonly ExchangeMessage[];
  readonly signal: CancellationSignal;
}

export interface ConversationSummarizer {
  summarize(request: SummaryRequest): Promise<string>;
}
