import { UnexpectedFakeCallError } from './test-errors';

export interface OllamaRequestBody {
  readonly model: string;
  readonly prompt: string;
  readonly raw?: boolean;
  readonly truncate?: boolean;
  readonly options: Readonly<Record<string, number>>;
  readonly stream: boolean;
  readonly keep_alive: number;
}

export interface OllamaLoad {
  readonly url: string;
  readonly body: OllamaRequestBody;
}

export interface HarmonyTurn {
  readonly role: string;
  readonly content: string;
}

export interface OllamaPrompt {
  readonly url: string;
  readonly body: OllamaRequestBody;
  readonly turns: readonly HarmonyTurn[];
  readonly instructions: string;
  readonly userMessage: string;
  readonly assistantPrefill: string;
  readonly promptTokens: number;
}

export interface ResponseReply {
  readonly response: string;
  readonly heldUntil?: Promise<void>;
}

export type OllamaReply =
  | ResponseReply
  | { completion: string }
  | { status: number }
  | { contextOverflow: true }
  | { body: Record<string, unknown> }
  | { hang: true };

const FAKE_ANALYSIS = 'The request is clear; I answer in the requested format.';
export const FAKE_REQUEST_TIMEOUT_MS = 10_000;
const PROMPT_TOKENS_PER_CALL = 1_250;
const INSTRUCTIONS_HEADING = '# Instructions\n\n';
const ASSISTANT_START = '<|start|>assistant';
const HARMONY_TURNS = /<\|start\|>([a-z]+)<\|message\|>([^]*?)<\|end\|>/gy;
const PROMPT_ROLES = 'system,developer,user';

const CONTEXT_OVERFLOW_BODY = JSON.stringify({
  error: JSON.stringify({
    error: {
      code: 400,
      message: 'request (101586 tokens) exceeds the available context size (98304 tokens)',
      type: 'exceed_context_size_error',
      n_prompt_tokens: 101586,
      n_ctx: 98304,
    },
  }),
});

function isNumberRecord(value: unknown): value is Readonly<Record<string, number>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'number')
  );
}

function isOllamaRequestBody(value: unknown): value is OllamaRequestBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'model' in value &&
    typeof value.model === 'string' &&
    'prompt' in value &&
    typeof value.prompt === 'string' &&
    'stream' in value &&
    typeof value.stream === 'boolean' &&
    'keep_alive' in value &&
    typeof value.keep_alive === 'number' &&
    'options' in value &&
    isNumberRecord(value.options) &&
    (!('raw' in value) || typeof value.raw === 'boolean') &&
    (!('truncate' in value) || typeof value.truncate === 'boolean')
  );
}

function parseRequestBody(url: string, text: string): OllamaRequestBody {
  const body: unknown = JSON.parse(text);
  if (!isOllamaRequestBody(body)) {
    throw new UnexpectedFakeCallError(`Ollama got a malformed request at ${url}: ${text}`);
  }
  return body;
}

function decodePrompt(url: string, body: OllamaRequestBody, promptTokens: number): OllamaPrompt {
  if (body.raw !== true || body.truncate !== false) {
    throw new UnexpectedFakeCallError('a harmony prompt must be sent raw and untruncated');
  }
  const matches = [...body.prompt.matchAll(HARMONY_TURNS)];
  const turns = matches.map(([, role = '', content = '']) => ({ role, content }));
  const framed = matches.reduce((length, [match]) => length + match.length, 0);
  const rest = body.prompt.slice(framed);
  const [, developer, user] = turns;
  if (
    turns.map(({ role }) => role).join() !== PROMPT_ROLES ||
    developer === undefined ||
    user === undefined ||
    !developer.content.startsWith(INSTRUCTIONS_HEADING) ||
    !rest.startsWith(ASSISTANT_START)
  ) {
    throw new UnexpectedFakeCallError(`Not a harmony prompt: ${body.prompt.slice(0, 120)}`);
  }
  return {
    url,
    body,
    turns,
    instructions: developer.content.slice(INSTRUCTIONS_HEADING.length),
    userMessage: user.content,
    assistantPrefill: rest.slice(ASSISTANT_START.length),
    promptTokens,
  };
}

function completionOf(reply: ResponseReply | { completion: string }): string {
  if ('completion' in reply) return reply.completion;
  return `<|channel|>analysis<|message|>${FAKE_ANALYSIS}<|end|><|start|>assistant<|channel|>final<|message|>${reply.response}`;
}

function hangUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

export class FakeOllama {
  readonly loads: OllamaLoad[] = [];
  readonly prompts: OllamaPrompt[] = [];
  private readonly replies: OllamaReply[] = [];

  config: Record<string, unknown> | null = {
    ollamaEndpoint: '/ollama/main/api/generate',
    model: 'test-model',
    requestTimeoutMs: FAKE_REQUEST_TIMEOUT_MS,
  };

  reply(...replies: OllamaReply[]): this {
    this.replies.push(...replies);
    return this;
  }

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
    const body = parseRequestBody(url, init.body);
    if (body.prompt === '') {
      if (body.raw !== undefined || body.truncate !== undefined) {
        throw new UnexpectedFakeCallError('a model load must not carry prompt options');
      }
      this.loads.push({ url, body });
      return new Response('{}', { status: 200 });
    }
    const prompt = decodePrompt(url, body, PROMPT_TOKENS_PER_CALL * (this.prompts.length + 1));
    this.prompts.push(prompt);
    const reply = this.replies.shift();
    if (!reply) {
      throw new UnexpectedFakeCallError(
        `Unexpected Ollama call: ${prompt.userMessage.slice(0, 80)}`,
      );
    }
    if ('hang' in reply) return hangUntilAborted(init.signal);
    if ('status' in reply) return new Response('error', { status: reply.status });
    if ('contextOverflow' in reply) return new Response(CONTEXT_OVERFLOW_BODY, { status: 400 });
    if ('body' in reply) return new Response(JSON.stringify(reply.body), { status: 200 });
    if ('heldUntil' in reply) await reply.heldUntil;
    return new Response(
      JSON.stringify({
        response: completionOf(reply),
        prompt_eval_count: prompt.promptTokens,
        done_reason: 'stop',
      }),
      { status: 200 },
    );
  };
}
