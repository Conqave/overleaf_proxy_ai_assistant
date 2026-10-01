import { AssistantProtocolError } from '../../ports/errors';
import { createCorrectionRequest, type ProtocolExchange } from './assistant-protocol';
import { InvalidAssistantResponse } from './assistant-response-parser';
import type { OllamaClient } from './ollama-client';

export async function runExchange<T>(
  client: OllamaClient,
  exchange: ProtocolExchange<T>,
): Promise<T> {
  const first = await client.generate(exchange.request);
  try {
    return exchange.parse(first);
  } catch (error) {
    if (!(error instanceof InvalidAssistantResponse)) throw error;
    const second = await client.generate(createCorrectionRequest(exchange, first, error.problem));
    try {
      return exchange.parse(second);
    } catch (retryError) {
      if (!(retryError instanceof InvalidAssistantResponse)) throw retryError;
      throw new AssistantProtocolError(
        `The assistant replied in an unexpected format (${retryError.problem}). Please try again.`,
        { cause: retryError },
      );
    }
  }
}
