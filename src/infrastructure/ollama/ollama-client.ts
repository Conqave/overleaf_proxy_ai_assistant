import {
  AssistantHttpError,
  AssistantReplyTruncatedError,
  AssistantRequestTooLargeError,
  AssistantResponseContractError,
  AssistantTimeoutError,
  AssistantUnreachableError,
} from '../../ports/errors';
import type { CancellationSignal } from '../../ports/cancellation';
import {
  parseFinalContinuation,
  parseHarmonyCompletion,
  renderFinalContinuation,
  renderHarmonyPrompt,
} from './harmony-format';
import { withDeadline } from '../deadline';
import { formatDuration } from '../duration';
import {
  CONTEXT_TOKENS,
  createTooLargeError,
  MAX_COMPLETION_TOKENS,
  PROMPT_TOKENS,
} from './context-budget';

export interface OllamaClientConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export interface GenerateRequest {
  readonly system: string;
  readonly prompt: string;
}

export interface Completion {
  readonly text: string;
  readonly promptTokens: number;
}

interface ModelOutput extends Completion {
  readonly stoppedAtLimit: boolean;
}

const TEMPERATURE = 0.2;
const HTTP_BAD_REQUEST = 400;
const CONTEXT_OVERFLOW_ERROR = 'exceed_context_size_error';
const DONE_STOP = 'stop';
const DONE_LENGTH = 'length';

export class OllamaClient {
  constructor(
    private readonly config: OllamaClientConfig,
    private readonly fetchFn: typeof fetch,
  ) {}

  async generate(request: GenerateRequest, signal: AbortSignal): Promise<Completion> {
    const prompt = renderHarmonyPrompt(request);
    const first = await this.complete(prompt, signal);
    const harmony = parseHarmonyCompletion(first.text);
    switch (harmony.kind) {
      case 'final':
        if (!first.stoppedAtLimit || harmony.analysis === null) return finish(first, harmony.text);
        return await this.completeFinal(prompt, first, harmony.analysis, signal);
      case 'unfinished':
        return await this.completeFinal(prompt, first, harmony.analysis, signal);
    }
  }

  private async completeFinal(
    prompt: string,
    first: ModelOutput,
    analysis: string,
    signal: AbortSignal,
  ): Promise<Completion> {
    if (first.promptTokens > PROMPT_TOKENS) throw createTooLargeError();
    const second = await this.complete(renderFinalContinuation(prompt, analysis), signal);
    return finish(second, parseFinalContinuation(second.text));
  }

  private async complete(prompt: string, signal: AbortSignal): Promise<ModelOutput> {
    const response = await this.post(
      { prompt, raw: true, truncate: false, options: this.getOptions() },
      signal,
    );
    const body = await this.readText(response, signal);
    if (!response.ok) throw createGenerateError(response, body);
    return getCompletion(parseJson(body));
  }

  loadModel(): Promise<void> {
    return this.withDeadline([], async (signal) => {
      const response = await this.post({ prompt: '', options: this.getOptions() }, signal);
      if (!response.ok) {
        throw new AssistantHttpError(
          `Loading the model failed with HTTP ${String(response.status)}`,
        );
      }
    });
  }

  withDeadline<T>(
    cancels: readonly CancellationSignal[],
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return withDeadline(this.config.timeoutMs, () => this.createTimeoutError(), cancels, run);
  }

  private getOptions(): { num_ctx: number; num_predict: number; temperature: number } {
    return {
      num_ctx: CONTEXT_TOKENS,
      num_predict: MAX_COMPLETION_TOKENS,
      temperature: TEMPERATURE,
    };
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchFn(this.config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.model, stream: false, keep_alive: -1, ...body }),
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof TypeError) {
        throw new AssistantUnreachableError('Ollama could not be reached.', { cause: error });
      }
      throw error;
    }
  }

  private async readText(response: Response, signal: AbortSignal): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof TypeError) {
        throw new AssistantUnreachableError('The reply from Ollama was interrupted.', {
          cause: error,
        });
      }
      throw error;
    }
  }

  private createTimeoutError(): AssistantTimeoutError {
    return new AssistantTimeoutError(
      `Ollama did not finish within ${formatDuration(this.config.timeoutMs)}.`,
    );
  }
}

function createGenerateError(
  response: Response,
  body: string,
): AssistantHttpError | AssistantRequestTooLargeError {
  if (response.status === HTTP_BAD_REQUEST && body.includes(CONTEXT_OVERFLOW_ERROR)) {
    return createTooLargeError();
  }
  return new AssistantHttpError(
    `Ollama answered HTTP ${String(response.status)} ${response.statusText}`.trim(),
  );
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AssistantResponseContractError('Ollama sent a body that is not JSON.', {
      cause: error,
    });
  }
}

function finish(output: ModelOutput, text: string): Completion {
  if (!output.stoppedAtLimit) return { text, promptTokens: output.promptTokens };
  checkContextLeft(output);
  throw new AssistantReplyTruncatedError(
    `The assistant's reply was longer than the ${MAX_COMPLETION_TOKENS.toLocaleString('en-US')} tokens one reply may have and was cut off; ask for the change in smaller parts.`,
  );
}

function checkContextLeft(output: ModelOutput): void {
  if (output.promptTokens + MAX_COMPLETION_TOKENS > CONTEXT_TOKENS) throw createTooLargeError();
}

function getCompletion(data: unknown): ModelOutput {
  if (typeof data !== 'object' || data === null || !('response' in data)) {
    throw new AssistantResponseContractError('Ollama returned no "response" field.');
  }
  if (typeof data.response !== 'string') {
    throw new AssistantResponseContractError('Ollama returned a non-text "response" field.');
  }
  if (!('prompt_eval_count' in data)) {
    throw new AssistantResponseContractError('Ollama returned no "prompt_eval_count" field.');
  }
  const promptTokens = data.prompt_eval_count;
  if (typeof promptTokens !== 'number' || !Number.isInteger(promptTokens) || promptTokens < 0) {
    throw new AssistantResponseContractError(
      'Ollama returned a "prompt_eval_count" that is not a token count.',
    );
  }
  if (!('done_reason' in data)) {
    throw new AssistantResponseContractError('Ollama returned no "done_reason" field.');
  }
  return { text: data.response, promptTokens, stoppedAtLimit: isStoppedAtLimit(data.done_reason) };
}

function isStoppedAtLimit(doneReason: unknown): boolean {
  if (doneReason === DONE_STOP) return false;
  if (doneReason === DONE_LENGTH) return true;
  throw new AssistantResponseContractError(
    `Ollama returned the unexpected "done_reason" ${JSON.stringify(doneReason)}.`,
  );
}
