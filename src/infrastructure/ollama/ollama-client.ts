import {
  AssistantHttpError,
  AssistantResponseContractError,
  AssistantTimeoutError,
  AssistantUnreachableError,
} from '../../ports/errors';
import {
  parseFinalContinuation,
  parseHarmonyCompletion,
  renderFinalContinuation,
  renderHarmonyPrompt,
} from './harmony-format';
import { CONTEXT_TOKENS, MAX_COMPLETION_TOKENS } from './context-budget';

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

const TEMPERATURE = 0.2;

export class OllamaClient {
  constructor(
    private readonly config: OllamaClientConfig,
    private readonly fetchFn: typeof fetch,
  ) {}

  async generate(request: GenerateRequest): Promise<Completion> {
    const prompt = renderHarmonyPrompt(request);
    const first = await this.complete(prompt);
    const harmony = parseHarmonyCompletion(first.text);
    if (harmony.kind === 'final') return { text: harmony.text, promptTokens: first.promptTokens };
    const second = await this.complete(renderFinalContinuation(prompt, harmony.analysis));
    return { text: parseFinalContinuation(second.text), promptTokens: second.promptTokens };
  }

  private complete(prompt: string): Promise<Completion> {
    return this.withTimeout(async (signal) => {
      const response = await this.post({ prompt, raw: true, options: this.getOptions() }, signal);
      if (!response.ok) {
        throw new AssistantHttpError(
          `Ollama answered HTTP ${String(response.status)} ${response.statusText}`.trim(),
        );
      }
      return getCompletion(await this.readJson(response, signal));
    });
  }

  loadModel(): Promise<void> {
    return this.withTimeout(async (signal) => {
      const response = await this.post({ prompt: '', options: this.getOptions() }, signal);
      if (!response.ok) {
        throw new AssistantHttpError(
          `Loading the model failed with HTTP ${String(response.status)}`,
        );
      }
    });
  }

  private async withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
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
      if (signal.aborted) throw this.createTimeoutError(error);
      if (error instanceof TypeError) {
        throw new AssistantUnreachableError('Ollama could not be reached.', { cause: error });
      }
      throw error;
    }
  }

  private async readJson(response: Response, signal: AbortSignal): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      if (signal.aborted) throw this.createTimeoutError(error);
      if (error instanceof SyntaxError) {
        throw new AssistantResponseContractError('Ollama sent a body that is not JSON.', {
          cause: error,
        });
      }
      throw error;
    }
  }

  private createTimeoutError(cause: unknown): AssistantTimeoutError {
    return new AssistantTimeoutError(
      `Ollama did not respond within ${formatDuration(this.config.timeoutMs)}.`,
      { cause },
    );
  }
}

function getCompletion(data: unknown): Completion {
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
  return { text: data.response, promptTokens };
}

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;

function formatDuration(ms: number): string {
  if (ms % MS_PER_MINUTE === 0) return formatUnit(ms / MS_PER_MINUTE, 'minute');
  if (ms % MS_PER_SECOND === 0) return formatUnit(ms / MS_PER_SECOND, 'second');
  return formatUnit(ms, 'millisecond');
}

function formatUnit(value: number, unit: 'minute' | 'second' | 'millisecond'): string {
  return new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay: 'long' }).format(value);
}
