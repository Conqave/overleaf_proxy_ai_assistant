import { AssistantRequestTooLargeError } from '../../ports/errors';
import { HARMONY_FRAMING_CHARS } from './harmony-format';

export const CONTEXT_TOKENS = 98_304;
export const MAX_COMPLETION_TOKENS = 4_096;
const COMPLETIONS_PER_GENERATION = 2;
const CHARS_PER_TOKEN = 2;

export const PROMPT_TOKENS = CONTEXT_TOKENS - COMPLETIONS_PER_GENERATION * MAX_COMPLETION_TOKENS;

export const PROMPT_BUDGET_CHARS = PROMPT_TOKENS * CHARS_PER_TOKEN - HARMONY_FRAMING_CHARS;

export function createTooLargeError(): AssistantRequestTooLargeError {
  return new AssistantRequestTooLargeError(
    "The message is too long for the model's context window; shorten it and try again.",
  );
}
