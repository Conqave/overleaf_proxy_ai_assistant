import type { ContextUsage } from '../../ports/agent-port';
import { AssistantProtocolError } from '../../ports/errors';
import { InvalidAssistantResponse } from './edit-reply-parser';
import { compact, estimatePromptTokens, LINE_BREAK, lines } from './prompt-blocks';
import type { GenerateRequest, OllamaClient } from './ollama-client';

const REJECTED_REPLY_CHARS = 3_000;

export interface ProtocolExchange<T> {
  readonly request: GenerateRequest;
  readonly retryInstruction: string;
  readonly parse: (raw: string) => T;
}

export interface ExchangeOutcome<T> {
  readonly value: T;
  readonly contextUsage: ContextUsage;
}

export async function runExchange<T>(
  client: OllamaClient,
  exchange: ProtocolExchange<T>,
): Promise<ExchangeOutcome<T>> {
  const first = await client.generate(exchange.request);
  try {
    return outcome(client, exchange.request, exchange.parse(first.text), first.promptTokens);
  } catch (error) {
    if (!(error instanceof InvalidAssistantResponse)) throw error;
    const correction = createCorrectionRequest(exchange, first.text, error.problem);
    const second = await client.generate(correction);
    try {
      return outcome(client, correction, exchange.parse(second.text), second.promptTokens);
    } catch (retryError) {
      if (!(retryError instanceof InvalidAssistantResponse)) throw retryError;
      throw new AssistantProtocolError(
        `The assistant replied in an unexpected format (${retryError.problem}). Please try again.`,
        { cause: retryError },
      );
    }
  }
}

function outcome<T>(
  client: OllamaClient,
  request: GenerateRequest,
  value: T,
  promptTokens: number,
): ExchangeOutcome<T> {
  return {
    value,
    contextUsage: {
      contextTokens: client.contextTokens,
      estimatedPromptTokens: estimatePromptTokens(request),
      promptTokens,
    },
  };
}

export function createCorrectionRequest(
  exchange: ProtocolExchange<unknown>,
  rejected: string,
  problem: string,
): GenerateRequest {
  return {
    system: exchange.request.system,
    prompt: lines(
      exchange.request.prompt,
      `Your previous reply was:${LINE_BREAK}${compact(rejected, REJECTED_REPLY_CHARS)}`,
      `It was rejected because: ${problem}.`,
      exchange.retryInstruction,
    ),
  };
}
