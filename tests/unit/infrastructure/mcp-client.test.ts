import { describe, expect, it } from 'vitest';
import {
  McpClient,
  McpContractError,
  McpHttpError,
  McpRequestError,
  McpUnreachableError,
} from '../../../src/infrastructure/mcp/mcp-client';
import {
  eventStream,
  FakeMcpServer,
  messageEvent,
  resultOf,
  toolResult,
  type McpReply,
} from '../../support/fake-mcp-server';
import { itemAt } from '../../support/guards';
import { TestFixtureError } from '../../support/test-errors';

const ENDPOINT = '/overleaf-ai-assistant/mcp/exa/';
const CLIENT_INFO = { name: 'hans', version: '1' };

function clientOf(server: FakeMcpServer): McpClient {
  return new McpClient(ENDPOINT, CLIENT_INFO, server.fetch);
}

const callTool = (client: McpClient, signal = new AbortController().signal) =>
  client.callTool('web_search_exa', { query: 'q' }, signal);

const answer =
  (text: string): McpReply =>
  (message) =>
    eventStream(messageEvent(resultOf(message, toolResult(text))));

describe('McpClient', () => {
  it('initializes a session, confirms it and calls the tool with its headers', async () => {
    const server = new FakeMcpServer().willAnswerTool(answer('found'));
    expect(await callTool(clientOf(server))).toEqual({ texts: ['found'], isError: false });
    expect(server.requests.map(({ message }) => message.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    const [initialize, initialized, call] = server.requests;
    expect(initialize?.message).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: CLIENT_INFO },
    });
    expect(initialize?.headers.get('Mcp-Session-Id')).toBeNull();
    expect(initialized?.message).not.toHaveProperty('id');
    expect(call?.message).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query: 'q' } },
    });
    for (const request of [initialized, call]) {
      expect(request?.headers.get('Mcp-Session-Id')).toBe('session-1');
      expect(request?.headers.get('MCP-Protocol-Version')).toBe('2025-06-18');
    }
    for (const request of server.requests) {
      expect(request.url).toBe(ENDPOINT);
      expect(request.credentials).toBe('same-origin');
      expect(request.headers.get('Accept')).toBe('application/json, text/event-stream');
      expect(request.headers.get('Content-Type')).toBe('application/json');
    }
  });

  it('keeps one session for later calls', async () => {
    const server = new FakeMcpServer().willAnswerTool(answer('one'), answer('two'));
    const client = clientOf(server);
    await callTool(client);
    expect(await callTool(client)).toMatchObject({ texts: ['two'] });
    expect(server.requests.filter(({ message }) => message.method === 'initialize')).toHaveLength(
      1,
    );
  });

  it('works without a session id when the server assigns none', async () => {
    const server = new FakeMcpServer().willAnswerTool(answer('found'));
    server.sessionId = null;
    await callTool(clientOf(server));
    expect(server.toolCalls[0]?.headers.has('Mcp-Session-Id')).toBe(false);
  });

  it('starts a new session once when the server forgot the old one', async () => {
    const server = new FakeMcpServer().willAnswerTool(answer('one'));
    const client = clientOf(server);
    await callTool(client);
    server.sessionId = 'session-2';
    server.willAnswerTool(() => new Response('gone', { status: 404 }), answer('two'));
    expect(await callTool(client)).toMatchObject({ texts: ['two'] });
    expect(itemAt(server.toolCalls, -1, 'tool call').headers.get('Mcp-Session-Id')).toBe(
      'session-2',
    );
    expect(server.requests.filter(({ message }) => message.method === 'initialize')).toHaveLength(
      2,
    );
  });

  it('reads the response from a stream with other events and split chunks', async () => {
    const server = new FakeMcpServer().willAnswerTool((message) => {
      const events = [
        ': keep-alive\n\n',
        'event: endpoint\ndata: ignored\n\n',
        messageEvent({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }),
        messageEvent(resultOf(message, toolResult('found'))),
      ].join('');
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let start = 0; start < events.length; start += 7) {
            controller.enqueue(encoder.encode(events.slice(start, start + 7)));
          }
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    expect(await callTool(clientOf(server))).toMatchObject({ texts: ['found'] });
  });

  it('reads a plain JSON response', async () => {
    const server = new FakeMcpServer().willAnswerTool(
      (message) =>
        new Response(JSON.stringify(resultOf(message, toolResult('json'))), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }),
    );
    expect(await callTool(clientOf(server))).toMatchObject({ texts: ['json'] });
  });

  it('returns only the text content and reports a tool error', async () => {
    const server = new FakeMcpServer().willAnswerTool((message) =>
      eventStream(
        messageEvent(
          resultOf(message, {
            content: [
              { type: 'image', data: 'x', mimeType: 'image/png' },
              { type: 'text', text: 'rate limited' },
            ],
            isError: true,
          }),
        ),
      ),
    );
    expect(await callTool(clientOf(server))).toEqual({ texts: ['rate limited'], isError: true });
  });

  it('turns a JSON-RPC error into a request error with its code', async () => {
    const server = new FakeMcpServer().willAnswerTool((message) =>
      eventStream(
        messageEvent({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: 'bad params' },
        }),
      ),
    );
    const failure = callTool(clientOf(server));
    await expect(failure).rejects.toThrow(McpRequestError);
    await expect(failure).rejects.toMatchObject({ code: -32602, detail: 'bad params' });
  });

  it('reports an HTTP failure and an unreachable server', async () => {
    const failing = new FakeMcpServer().willAnswerTool(() => new Response('busy', { status: 503 }));
    await expect(callTool(clientOf(failing))).rejects.toMatchObject({
      constructor: McpHttpError,
      status: 503,
    });
    const offline = new McpClient(ENDPOINT, CLIENT_INFO, () =>
      Promise.reject(new TypeError('Failed to fetch')),
    );
    await expect(callTool(offline)).rejects.toThrow(McpUnreachableError);
  });

  it('reports an interrupted event stream as unreachable', async () => {
    const server = new FakeMcpServer().willAnswerTool(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: message\n'));
          controller.error(new TypeError('network error'));
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    await expect(callTool(clientOf(server))).rejects.toThrow(McpUnreachableError);
  });

  it.each<[string, (server: FakeMcpServer) => void, string]>([
    [
      'an unsupported protocol version',
      (server) => {
        server.protocolVersion = '2024-11-05';
      },
      'protocol version "2024-11-05"',
    ],
    [
      'a server without tools',
      (server) => {
        server.initializeReply = (message) =>
          eventStream(
            messageEvent(resultOf(message, { protocolVersion: '2025-06-18', capabilities: {} })),
          );
      },
      'offers no tools',
    ],
    [
      'an invalid session id',
      (server) => {
        server.sessionId = 'two words';
      },
      'invalid session id',
    ],
    [
      'an initialized notification answered with 200',
      (server) => {
        server.notificationReply = () => new Response(null, { status: 200 });
      },
      'instead of 202',
    ],
    [
      'an unknown content type',
      (server) => {
        server.willAnswerTool(
          () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
        );
      },
      'content type "text/html"',
    ],
    [
      'a stream without the response',
      (server) => {
        server.willAnswerTool(() =>
          eventStream(messageEvent({ jsonrpc: '2.0', id: 99, result: {} })),
        );
      },
      'ended without the response to request 2',
    ],
    [
      'an event that is not JSON',
      (server) => {
        server.willAnswerTool(() => eventStream('event: message\ndata: {broken\n\n'));
      },
      'not JSON',
    ],
    [
      'a response that is not JSON-RPC 2.0',
      (server) => {
        server.willAnswerTool((message) =>
          eventStream(messageEvent({ jsonrpc: '1.0', id: message.id, result: {} })),
        );
      },
      'not JSON-RPC 2.0',
    ],
    [
      'a response with a result and an error',
      (server) => {
        server.willAnswerTool((message) =>
          eventStream(
            messageEvent({
              jsonrpc: '2.0',
              id: message.id,
              result: {},
              error: { code: 1, message: 'x' },
            }),
          ),
        );
      },
      'both a result and an error',
    ],
    [
      'a tool result without content',
      (server) => {
        server.willAnswerTool((message) => eventStream(messageEvent(resultOf(message, {}))));
      },
      'no content list',
    ],
    [
      'text content without text',
      (server) => {
        server.willAnswerTool((message) =>
          eventStream(messageEvent(resultOf(message, { content: [{ type: 'text' }] }))),
        );
      },
      'text content without text',
    ],
  ])('rejects %s as a broken contract', async (_name, breakServer, problem) => {
    const server = new FakeMcpServer();
    breakServer(server);
    const failure = callTool(clientOf(server));
    await expect(failure).rejects.toThrow(McpContractError);
    await expect(failure).rejects.toThrow(problem);
  });

  it('stops with the reason of a cancellation', async () => {
    const server = new FakeMcpServer();
    const controller = new AbortController();
    const reason = new TestFixtureError('cancelled');
    controller.abort(reason);
    await expect(callTool(clientOf(server), controller.signal)).rejects.toBe(reason);
  });
});
