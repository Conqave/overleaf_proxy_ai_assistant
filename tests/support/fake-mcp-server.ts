import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TestFixtureError, UnexpectedFakeCallError } from './test-errors';

export interface McpRequestRecord {
  readonly url: string;
  readonly headers: Headers;
  readonly credentials: RequestCredentials | undefined;
  readonly message: Readonly<Record<string, unknown>>;
}

export type McpReply = (message: Readonly<Record<string, unknown>>) => Response;

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/exa-web-search.sse');

export function readExaSearchFixture(): Readonly<Record<string, unknown>> {
  const data = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('data: '));
  if (data === undefined) throw new TestFixtureError(`${FIXTURE} holds no event data`);
  const message: unknown = JSON.parse(data.slice('data: '.length));
  if (!isRecord(message) || !isRecord(message.result)) {
    throw new TestFixtureError(`${FIXTURE} holds no JSON-RPC result`);
  }
  return message.result;
}

export function eventStream(...events: readonly string[]): Response {
  return new Response(events.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

export function messageEvent(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

export function resultOf(message: Readonly<Record<string, unknown>>, result: unknown): unknown {
  return { jsonrpc: '2.0', id: message.id, result };
}

export function toolResult(text: string, isError = false): unknown {
  return { content: [{ type: 'text', text }], isError };
}

export function toolAnswer(text: string, isError = false): McpReply {
  return (message) => eventStream(messageEvent(resultOf(message, toolResult(text, isError))));
}

export class FakeMcpServer {
  readonly requests: McpRequestRecord[] = [];
  sessionId: string | null = 'session-1';
  protocolVersion = '2025-06-18';
  initializeReply: McpReply = (message) =>
    new Response(
      messageEvent(
        resultOf(message, {
          protocolVersion: this.protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'fake-exa', version: '1' },
        }),
      ),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          ...(this.sessionId === null ? {} : { 'Mcp-Session-Id': this.sessionId }),
        },
      },
    );
  notificationReply: () => Response = () => new Response(null, { status: 202 });
  private readonly toolReplies: McpReply[] = [];

  willAnswerTool(...replies: McpReply[]): this {
    this.toolReplies.push(...replies);
    return this;
  }

  get toolCalls(): McpRequestRecord[] {
    return this.requests.filter(({ message }) => message.method === 'tools/call');
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input !== 'string' || init?.body === undefined || typeof init.body !== 'string') {
      throw new TestFixtureError('the MCP client posts a string body to a path');
    }
    init.signal?.throwIfAborted();
    const message: unknown = JSON.parse(init.body);
    if (!isRecord(message)) throw new TestFixtureError('the MCP client posts a JSON object');
    this.requests.push({
      url: input,
      headers: new Headers(init.headers),
      credentials: init.credentials,
      message,
    });
    await Promise.resolve();
    init.signal?.throwIfAborted();
    switch (message.method) {
      case 'initialize':
        return this.initializeReply(message);
      case 'notifications/initialized':
        return this.notificationReply();
      case 'tools/call': {
        const reply = this.toolReplies.shift();
        if (reply === undefined) throw new UnexpectedFakeCallError('no tool reply is scripted');
        return reply(message);
      }
      default:
        throw new UnexpectedFakeCallError(`unexpected MCP method ${String(message.method)}`);
    }
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
