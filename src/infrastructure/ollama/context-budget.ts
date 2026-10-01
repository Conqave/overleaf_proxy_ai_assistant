import { NamedError } from '../../domain/errors';
import { AssistantRequestTooLargeError } from '../../ports/errors';
import { HARMONY_FRAMING_CHARS } from './harmony-format';

export const CONTEXT_TOKENS = 98_304;
export const MAX_COMPLETION_TOKENS = 4_096;
const COMPLETIONS_PER_GENERATION = 2;
const ESTIMATED_CHARS_PER_TOKEN = 2;
const MEASURED_RATIO_MARGIN = 0.9;

export const SEARCH_OUTPUT_CHARS = 8_000;

export const PROMPT_TOKENS = CONTEXT_TOKENS - COMPLETIONS_PER_GENERATION * MAX_COMPLETION_TOKENS;

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
    return await run(getPromptChars(ESTIMATED_CHARS_PER_TOKEN));
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

export function createMessageTooLargeError(): AssistantRequestTooLargeError {
  return new AssistantRequestTooLargeError(
    "Your message is too long for the model's context window, even with the project content shortened to a minimum; shorten the message and try again.",
  );
}
