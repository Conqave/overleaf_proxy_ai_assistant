import type { ContextUsage } from '../../ports/agent-port';
import { AssistantProtocolError } from '../../ports/errors';
import { InvalidAssistantResponse } from './reply-parser';
import { describeUsage } from './context-budget';
import { compact, LINE_BREAK, lines } from './prompt-blocks';
import { HarmonyFormatError } from './harmony-format';
import type { Completion, GenerateRequest, OllamaClient } from './ollama-client';

const REJECTED_REPLY_CHARS = 3_000;
const PROBLEM_CHARS = 1_000;

export interface ProtocolExchange<T> {
  readonly request: GenerateRequest;
  readonly retryInstruction: string;
  readonly parse: (raw: string) => T;
}

export interface ExchangeOutcome<T> {
  readonly value: T;
  readonly contextUsage: ContextUsage;
  readonly promptChars: number;
}

type Attempt<T> =
  | { readonly kind: 'accepted'; readonly outcome: ExchangeOutcome<T> }
  | { readonly kind: 'rejected'; readonly reply: string; readonly error: RejectedReplyError };

type RejectedReplyError = InvalidAssistantResponse | HarmonyFormatError;

export async function runExchange<T>(
  client: OllamaClient,
  exchange: ProtocolExchange<T>,
  signal: AbortSignal,
): Promise<ExchangeOutcome<T>> {
  const first = await attempt(client, exchange.request, exchange.parse, signal);
  if (first.kind === 'accepted') return first.outcome;
  const correction = createCorrectionRequest(exchange, first.reply, first.error.problem);
  const second = await attempt(client, correction, exchange.parse, signal);
  if (second.kind === 'accepted') return second.outcome;
  throw new AssistantProtocolError(
    `The assistant replied in an unexpected format (${compact(second.error.problem, PROBLEM_CHARS)}). Please try again.`,
    { cause: second.error },
  );
}

async function attempt<T>(
  client: OllamaClient,
  request: GenerateRequest,
  parse: (raw: string) => T,
  signal: AbortSignal,
): Promise<Attempt<T>> {
  const completion = await generate(client, request, signal);
  if (completion instanceof HarmonyFormatError) {
    return { kind: 'rejected', reply: completion.completion, error: completion };
  }
  try {
    return {
      kind: 'accepted',
      outcome: outcome(parse(completion.text), completion),
    };
  } catch (error) {
    if (!(error instanceof InvalidAssistantResponse)) throw error;
    return { kind: 'rejected', reply: completion.text, error };
  }
}

async function generate(
  client: OllamaClient,
  request: GenerateRequest,
  signal: AbortSignal,
): Promise<Completion | HarmonyFormatError> {
  try {
    return await client.generate(request, signal);
  } catch (error) {
    if (!(error instanceof HarmonyFormatError)) throw error;
    return error;
  }
}

function outcome<T>(value: T, { promptChars, promptTokens }: Completion): ExchangeOutcome<T> {
  return { value, contextUsage: describeUsage(promptTokens), promptChars };
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
      correctionText(
        compact(rejected, REJECTED_REPLY_CHARS),
        compact(problem, PROBLEM_CHARS),
        exchange.retryInstruction,
      ),
    ),
  };
}

export function getCorrectionReserveChars(retryInstruction: string): number {
  const framing = correctionText('', '', retryInstruction).length;
  return LINE_BREAK.length + framing + REJECTED_REPLY_CHARS + PROBLEM_CHARS;
}

function correctionText(rejected: string, problem: string, retryInstruction: string): string {
  return lines(
    `Your previous reply was:${LINE_BREAK}${rejected}`,
    `It was rejected because: ${problem}.`,
    retryInstruction,
  );
}
