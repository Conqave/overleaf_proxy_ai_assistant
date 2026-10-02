import type { WebSearchResult } from '../domain/web-search';
import type { CancellationSignal } from './cancellation';

export interface WebSearchPort {
  search(query: string, signal: CancellationSignal): Promise<readonly WebSearchResult[]>;
}
