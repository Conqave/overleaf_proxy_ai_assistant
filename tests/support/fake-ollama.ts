import { UnexpectedFakeCallError } from './test-errors';

interface OllamaRequestBody {
  model: string;
  prompt: string;
  raw?: boolean;
  options?: Record<string, number>;
  stream: boolean;
  keep_alive: number;
}

export interface OllamaCall {
  url: string;
  harmonyPrompt: string;
  body: Omit<OllamaRequestBody, 'prompt'> & { system?: string; prompt: string };
}

export type OllamaReply =
  { response: string } | { completion: string } | { status: number } | { hang: true };

const HARMONY_REQUEST =
  /<\|start\|>developer<\|message\|># Instructions\n\n([\s\S]*)<\|end\|><\|start\|>user<\|message\|>([\s\S]*?)<\|end\|><\|start\|>assistant/;

function decodeBody(body: OllamaRequestBody): OllamaCall['body'] {
  if (body.prompt === '') return body;
  const match = HARMONY_REQUEST.exec(body.prompt);
  const system = match?.[1];
  const prompt = match?.[2];
  if (system === undefined || prompt === undefined) {
    throw new UnexpectedFakeCallError(`Not a harmony prompt: ${body.prompt.slice(0, 80)}`);
  }
  return { ...body, system, prompt };
}

function completionOf(reply: { response: string } | { completion: string }): string {
  return 'completion' in reply ? reply.completion : `<|channel|>final<|message|>${reply.response}`;
}

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
    const sent = JSON.parse(init.body) as OllamaRequestBody;
    const call = { url, harmonyPrompt: sent.prompt, body: decodeBody(sent) };
    this.calls.push(call);
    if (sent.prompt === '') return new Response('{}', { status: 200 });
    this.onPrompt?.(call);
    const reply = this.replies.shift();
    if (!reply)
      throw new UnexpectedFakeCallError(`Unexpected Ollama call: ${call.body.prompt.slice(0, 80)}`);
    if ('hang' in reply) {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    if ('status' in reply) return new Response('error', { status: reply.status });
    return new Response(
      JSON.stringify({ response: completionOf(reply), prompt_eval_count: sent.prompt.length }),
      { status: 200 },
    );
  };
}
