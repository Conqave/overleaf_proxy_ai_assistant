import { NamedError } from '../../domain/errors';
import { ContextPressure, type ContextUsage } from '../../ports/agent-port';
import { AssistantRequestTooLargeError } from '../../ports/errors';
import { HARMONY_FRAMING_CHARS } from './harmony-format';

export const CONTEXT_TOKENS = 98_304;
export const MAX_COMPLETION_TOKENS = 4_096;
const COMPLETIONS_PER_GENERATION = 2;
const ESTIMATED_CHARS_PER_TOKEN = 2;
const MEASURED_RATIO_MARGIN = 0.9;

export const PROMPT_TOKENS = CONTEXT_TOKENS - COMPLETIONS_PER_GENERATION * MAX_COMPLETION_TOKENS;

export const SEARCH_OUTPUT_CHARS = 8_000;
export const OLDER_RESULT_CHARS = 2_000;
export const CURRENT_RESULT_SHARE = 10;

const AUTO_COMPACTION_RATIO = 0.8;
export const AUTO_COMPACTION_TOKENS = Math.floor(PROMPT_TOKENS * AUTO_COMPACTION_RATIO);
export const PRESERVED_RECENT_TOKENS = 20_000;
export const MANUAL_COMPACTION_KEEP_RATIO = 0.5;
export const MIN_COMPACTED_TOKENS = 2_000;
const MAX_UNDERESTIMATE_FACTOR = 4;

const ELEVATED_USAGE_RATIO = 0.6;
const HIGH_USAGE_RATIO = 0.8;

export class TokenEstimate {
  private underestimate = 1;

  calibrate(promptChars: number, promptTokens: number): void {
    const estimated = promptChars / ESTIMATED_CHARS_PER_TOKEN;
    this.underestimate = Math.min(MAX_UNDERESTIMATE_FACTOR, Math.max(1, promptTokens / estimated));
  }

  tokensOf(chars: number): number {
    return Math.ceil((chars / ESTIMATED_CHARS_PER_TOKEN) * this.underestimate);
  }
}

export function describeUsage(promptTokens: number): ContextUsage {
  return { contextTokens: CONTEXT_TOKENS, promptTokens, pressure: getPressure(promptTokens) };
}

function getPressure(promptTokens: number): ContextPressure {
  const ratio = promptTokens / CONTEXT_TOKENS;
  if (ratio >= HIGH_USAGE_RATIO) return ContextPressure.High;
  if (ratio >= ELEVATED_USAGE_RATIO) return ContextPressure.Elevated;
  return ContextPressure.Low;
}

export class ContextOverflowError extends NamedError {
  constructor(
    readonly promptChars: number,
    readonly promptTokens: number,
  ) {
    super(
      `a prompt of ${String(promptChars)} characters took ${String(promptTokens)} tokens, more than the ${String(PROMPT_TOKENS)} tokens planned for a prompt`,
    );
  }
}

export async function fitIntoContext<T>(run: (promptChars: number) => Promise<T>): Promise<T> {
  try {
    return await run(ESTIMATED_PROMPT_CHARS);
  } catch (error) {
    if (!(error instanceof ContextOverflowError)) throw error;
    return await runMeasured(run, error);
  }
}

async function runMeasured<T>(
  run: (promptChars: number) => Promise<T>,
  overflow: ContextOverflowError,
): Promise<T> {
  const charsPerToken = (overflow.promptChars / overflow.promptTokens) * MEASURED_RATIO_MARGIN;
  try {
    return await run(getPromptChars(charsPerToken));
  } catch (error) {
    if (!(error instanceof ContextOverflowError)) throw error;
    throw new AssistantRequestTooLargeError(
      `Even with the documents, results and conversation shortened, the request took ${String(error.promptTokens)} tokens of the model's context window of ${String(CONTEXT_TOKENS)}; please start a new chat and try again.`,
      { cause: error },
    );
  }
}

function getPromptChars(charsPerToken: number): number {
  return Math.floor(PROMPT_TOKENS * charsPerToken) - HARMONY_FRAMING_CHARS;
}

export const ESTIMATED_PROMPT_CHARS = getPromptChars(ESTIMATED_CHARS_PER_TOKEN);

export function createMessageTooLargeError(): AssistantRequestTooLargeError {
  return new AssistantRequestTooLargeError(
    "Your message is too long for the model's context window, even with the project content shortened to a minimum; shorten the message and try again.",
  );
}
