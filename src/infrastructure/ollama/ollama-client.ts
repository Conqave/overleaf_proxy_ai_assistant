import {
  AssistantHttpError,
  AssistantResponseContractError,
  AssistantTimeoutError,
  AssistantUnreachableError,
} from '../../ports/errors';

export interface OllamaClientConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly contextTokens: number;
  readonly timeoutMs: number;
}

export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

export interface GenerateRequest {
  readonly system: string;
  readonly prompt: string;
}

const TEMPERATURE = 0.2;

export class OllamaClient {
  constructor(
    private readonly config: OllamaClientConfig,
    private readonly fetch: FetchFunction,
  ) {}

  generate(request: GenerateRequest): Promise<string> {
    return this.withTimeout(async (signal) => {
      const response = await this.post(
        { system: request.system, prompt: request.prompt, options: this.getOptions() },
        signal,
      );
      if (!response.ok) {
        throw new AssistantHttpError(
          response.status,
          `Ollama answered HTTP ${String(response.status)} ${response.statusText}`.trim(),
        );
      }
      return getResponseText(await this.readJson(response, signal));
    });
  }

  loadModel(): Promise<void> {
    return this.withTimeout(async (signal) => {
      const response = await this.post({ prompt: '', options: this.getOptions() }, signal);
      if (!response.ok) {
        throw new AssistantHttpError(
          response.status,
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

  private getOptions(): { num_ctx: number; temperature: number } {
    return { num_ctx: this.config.contextTokens, temperature: TEMPERATURE };
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetch(this.config.endpoint, {
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

function getResponseText(data: unknown): string {
  if (typeof data !== 'object' || data === null || !('response' in data)) {
    throw new AssistantResponseContractError('Ollama returned no "response" field.');
  }
  if (typeof data.response !== 'string') {
    throw new AssistantResponseContractError('Ollama returned a non-text "response" field.');
  }
  return data.response;
}

function formatDuration(ms: number): string {
  if (ms % 60000 === 0) return `${String(ms / 60000)} minutes`;
  return `${String(Math.round(ms / 1000))} seconds`;
}
