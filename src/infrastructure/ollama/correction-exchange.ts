import type { ContextUsage } from '../../ports/agent-port';
import { AssistantProtocolError } from '../../ports/errors';
import { InvalidAssistantResponse } from './edit-reply-parser';
import { compact, estimatePromptTokens, LINE_BREAK, lines } from './prompt-blocks';
import { HarmonyFormatError } from './harmony-format';
import type { Completion, GenerateRequest, OllamaClient } from './ollama-client';

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

type Attempt<T> =
  | { readonly kind: 'accepted'; readonly outcome: ExchangeOutcome<T> }
  | { readonly kind: 'rejected'; readonly reply: string; readonly error: RejectedReplyError };

type RejectedReplyError = InvalidAssistantResponse | HarmonyFormatError;

export async function runExchange<T>(
  client: OllamaClient,
  exchange: ProtocolExchange<T>,
): Promise<ExchangeOutcome<T>> {
  const first = await attempt(client, exchange.request, exchange.parse);
  if (first.kind === 'accepted') return first.outcome;
  const correction = createCorrectionRequest(exchange, first.reply, first.error.problem);
  const second = await attempt(client, correction, exchange.parse);
  if (second.kind === 'accepted') return second.outcome;
  throw new AssistantProtocolError(
    `The assistant replied in an unexpected format (${second.error.problem}). Please try again.`,
    { cause: second.error },
  );
}

async function attempt<T>(
  client: OllamaClient,
  request: GenerateRequest,
  parse: (raw: string) => T,
): Promise<Attempt<T>> {
  const completion = await generate(client, request);
  if (completion instanceof HarmonyFormatError) {
    return { kind: 'rejected', reply: completion.completion, error: completion };
  }
  try {
    return {
      kind: 'accepted',
      outcome: outcome(client, request, parse(completion.text), completion.promptTokens),
    };
  } catch (error) {
    if (!(error instanceof InvalidAssistantResponse)) throw error;
    return { kind: 'rejected', reply: completion.text, error };
  }
}

async function generate(
  client: OllamaClient,
  request: GenerateRequest,
): Promise<Completion | HarmonyFormatError> {
  try {
    return await client.generate(request);
  } catch (error) {
    if (!(error instanceof HarmonyFormatError)) throw error;
    return error;
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
