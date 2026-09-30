import { UnexpectedFakeCallError } from './test-errors';

export interface OllamaCall {
  url: string;
  body: {
    model: string;
    system?: string;
    prompt: string;
    options?: Record<string, number>;
    stream: boolean;
    keep_alive: number;
  };
}

export type OllamaReply =
  { response: string; thinking?: string } | { status: number } | { hang: true };

export class FakeOllama {
  readonly calls: OllamaCall[] = [];
  private readonly replies: OllamaReply[] = [];

  reply(...replies: OllamaReply[]): this {
    this.replies.push(...replies);
    return this;
  }

  get promptCalls(): OllamaCall[] {
    return this.calls.filter((call) => call.body.prompt !== '');
  }

  onPrompt: ((call: OllamaCall) => void) | null = null;

  config: Record<string, unknown> | null = {
    ollamaEndpoint: '/ollama/main/api/generate',
    model: 'test-model',
    requestTimeoutMs: 200,
    contextTokens: 16_384,
  };

  readonly fetch: typeof fetch = async (url, init) => {
    if (typeof url !== 'string') {
      throw new UnexpectedFakeCallError('Ollama was called with a non-string URL');
    }
    if (url === '/overleaf-ai-assistant/config.json') {
      return this.config
        ? new Response(JSON.stringify(this.config), { status: 200 })
        : new Response('missing', { status: 404 });
    }
    if (typeof init?.body !== 'string') {
      throw new UnexpectedFakeCallError(`Ollama was called at ${url} without a JSON body`);
    }
    const body = JSON.parse(init.body) as OllamaCall['body'];
    this.calls.push({ url, body });
    if (body.prompt === '') return new Response('{}', { status: 200 });
    this.onPrompt?.({ url, body });
    const reply = this.replies.shift();
    if (!reply)
      throw new UnexpectedFakeCallError(`Unexpected Ollama call: ${body.prompt.slice(0, 80)}`);
    if ('hang' in reply) {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    if ('status' in reply) return new Response('error', { status: reply.status });
    return new Response(JSON.stringify(reply), { status: 200 });
  };
}
