import { ParseError, type EventSourceMessage } from 'eventsource-parser';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { NamedError } from '../../domain/errors';

const LATEST_PROTOCOL_VERSION = '2025-06-18';
const PROTOCOL_VERSIONS: readonly string[] = [LATEST_PROTOCOL_VERSION, '2025-03-26'];

const JSON_RPC_VERSION = '2.0';
const SESSION_HEADER = 'Mcp-Session-Id';
const PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version';
const ACCEPTED_TYPES = 'application/json, text/event-stream';
const JSON_TYPE = 'application/json';
const EVENT_STREAM_TYPE = 'text/event-stream';
const MESSAGE_EVENT = 'message';
const HTTP_ACCEPTED = 202;
const HTTP_NOT_FOUND = 404;
const MAX_EVENT_CHARS = 1_000_000;
const SESSION_ID = /^[\x21-\x7E]+$/;

export class McpUnreachableError extends NamedError {}

export class McpHttpError extends NamedError {
  constructor(readonly status: number) {
    super(`the MCP server answered HTTP ${String(status)}`);
  }
}

export class McpContractError extends NamedError {}

export class McpRequestError extends NamedError {
  constructor(
    readonly code: number,
    readonly detail: string,
  ) {
    super(`the MCP server rejected the request with error ${String(code)}: ${detail}`);
  }
}

class McpSessionExpiredError extends NamedError {}

export interface McpClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpToolResult {
  readonly texts: readonly string[];
  readonly isError: boolean;
}

interface McpSession {
  readonly id: string | null;
  readonly protocolVersion: string;
}

type JsonObject = Readonly<Record<string, unknown>>;

export class McpClient {
  private session: McpSession | null = null;
  private lastRequestId = 0;

  constructor(
    private readonly endpoint: string,
    private readonly clientInfo: McpClientInfo,
    private readonly fetchFn: typeof fetch,
  ) {}

  async callTool(name: string, args: JsonObject, signal: AbortSignal): Promise<McpToolResult> {
    const params = { name, arguments: args };
    const session = await this.connect(signal);
    try {
      return parseToolResult(await this.request(session, 'tools/call', params, signal));
    } catch (error) {
      if (!(error instanceof McpSessionExpiredError)) throw error;
      this.session = null;
    }
    const renewed = await this.connect(signal);
    return parseToolResult(await this.request(renewed, 'tools/call', params, signal));
  }

  private async connect(signal: AbortSignal): Promise<McpSession> {
    this.session ??= await this.initialize(signal);
    return this.session;
  }

  private async initialize(signal: AbortSignal): Promise<McpSession> {
    const id = this.takeRequestId();
    const response = await this.post(
      {
        jsonrpc: JSON_RPC_VERSION,
        id,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: this.clientInfo,
        },
      },
      null,
      signal,
    );
    if (!response.ok) {
      await discardBody(response);
      throw new McpHttpError(response.status);
    }
    const sessionId = parseSessionId(response.headers.get(SESSION_HEADER));
    const result = await readResult(response, id, signal);
    const session = { id: sessionId, protocolVersion: parseInitializeResult(result) };
    await this.notifyInitialized(session, signal);
    return session;
  }

  private async notifyInitialized(session: McpSession, signal: AbortSignal): Promise<void> {
    const response = await this.post(
      { jsonrpc: JSON_RPC_VERSION, method: 'notifications/initialized' },
      session,
      signal,
    );
    await discardBody(response);
    if (!response.ok) throw new McpHttpError(response.status);
    if (response.status !== HTTP_ACCEPTED) {
      throw new McpContractError(
        `the MCP server answered the initialized notification with HTTP ${String(response.status)} instead of ${String(HTTP_ACCEPTED)}`,
      );
    }
  }

  private async request(
    session: McpSession,
    method: string,
    params: JsonObject,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    const id = this.takeRequestId();
    const response = await this.post(
      { jsonrpc: JSON_RPC_VERSION, id, method, params },
      session,
      signal,
    );
    if (response.status === HTTP_NOT_FOUND && session.id !== null) {
      await discardBody(response);
      throw new McpSessionExpiredError(`the MCP server no longer knows session ${session.id}`);
    }
    if (!response.ok) {
      await discardBody(response);
      throw new McpHttpError(response.status);
    }
    return await readResult(response, id, signal);
  }

  private takeRequestId(): number {
    this.lastRequestId += 1;
    return this.lastRequestId;
  }

  private async post(
    message: JsonObject,
    session: McpSession | null,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers = new Headers({ Accept: ACCEPTED_TYPES, 'Content-Type': JSON_TYPE });
    if (session !== null) {
      headers.set(PROTOCOL_VERSION_HEADER, session.protocolVersion);
      if (session.id !== null) headers.set(SESSION_HEADER, session.id);
    }
    try {
      return await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        credentials: 'same-origin',
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof TypeError) {
        throw new McpUnreachableError('the MCP server could not be reached', { cause: error });
      }
      throw error;
    }
  }
}

function parseSessionId(value: string | null): string | null {
  if (value === null) return null;
  if (!SESSION_ID.test(value)) {
    throw new McpContractError(
      `the MCP server sent the invalid session id ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function parseInitializeResult(result: JsonObject): string {
  const version = result.protocolVersion;
  if (typeof version !== 'string' || !PROTOCOL_VERSIONS.includes(version)) {
    throw new McpContractError(
      `the MCP server speaks protocol version ${JSON.stringify(version)}, not one of ${PROTOCOL_VERSIONS.join(', ')}`,
    );
  }
  const capabilities = result.capabilities;
  if (!isJsonObject(capabilities) || !isJsonObject(capabilities.tools)) {
    throw new McpContractError('the MCP server offers no tools');
  }
  return version;
}

function parseToolResult(result: JsonObject): McpToolResult {
  const { content, isError } = result;
  if (!Array.isArray(content)) throw new McpContractError('the tool result has no content list');
  if (isError !== undefined && typeof isError !== 'boolean') {
    throw new McpContractError('the tool result has a non-boolean isError');
  }
  return { texts: content.flatMap(parseTextContent), isError: isError === true };
}

function parseTextContent(item: unknown): string[] {
  if (!isJsonObject(item) || typeof item.type !== 'string') {
    throw new McpContractError('the tool result holds content without a type');
  }
  if (item.type !== 'text') return [];
  if (typeof item.text !== 'string') {
    throw new McpContractError('the tool result holds text content without text');
  }
  return [item.text];
}

async function readResult(
  response: Response,
  id: number,
  signal: AbortSignal,
): Promise<JsonObject> {
  const type = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  switch (type) {
    case JSON_TYPE:
      return parseResponse(parseJson(await readText(response, signal)), id);
    case EVENT_STREAM_TYPE:
      return await readEventStream(response, id, signal);
    default:
      await discardBody(response);
      throw new McpContractError(
        `the MCP server answered with the content type ${JSON.stringify(type ?? null)}`,
      );
  }
}

async function readEventStream(
  response: Response,
  id: number,
  signal: AbortSignal,
): Promise<JsonObject> {
  if (response.body === null)
    throw new McpContractError('the MCP server sent an empty event stream');
  const events = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new EventSourceParserStream({ onError: 'terminate', maxBufferSize: MAX_EVENT_CHARS }),
    )
    .getReader();
  for (;;) {
    const { done, value } = await readEvent(events, signal);
    if (done) {
      throw new McpContractError(
        `the event stream ended without the response to request ${String(id)}`,
      );
    }
    if (value.event !== undefined && value.event !== MESSAGE_EVENT) continue;
    const message = parseJson(value.data);
    if (!isResponseTo(message, id)) continue;
    await events.cancel();
    return parseResponse(message, id);
  }
}

async function readEvent(
  events: ReadableStreamDefaultReader<EventSourceMessage>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<EventSourceMessage>> {
  try {
    return await events.read();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ParseError) {
      throw new McpContractError(`the MCP server sent a broken event stream: ${error.message}`, {
        cause: error,
      });
    }
    if (error instanceof TypeError) {
      throw new McpUnreachableError('the answer of the MCP server was interrupted', {
        cause: error,
      });
    }
    throw error;
  }
}

async function readText(response: Response, signal: AbortSignal): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof TypeError) {
      throw new McpUnreachableError('the answer of the MCP server was interrupted', {
        cause: error,
      });
    }
    throw error;
  }
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel();
}

function isResponseTo(message: unknown, id: number): boolean {
  return isJsonObject(message) && message.id === id && !('method' in message);
}

function parseResponse(message: unknown, id: number): JsonObject {
  if (!isJsonObject(message) || message.jsonrpc !== JSON_RPC_VERSION) {
    throw new McpContractError('the MCP server sent a message that is not JSON-RPC 2.0');
  }
  if (message.id !== id) {
    throw new McpContractError(
      `the MCP server answered request ${JSON.stringify(message.id)} instead of ${String(id)}`,
    );
  }
  const { result, error } = message;
  if (error !== undefined) {
    if (result !== undefined)
      throw new McpContractError('the response has both a result and an error');
    throw parseRequestError(error);
  }
  if (!isJsonObject(result)) throw new McpContractError('the response has no result object');
  return result;
}

function parseRequestError(error: unknown): McpRequestError {
  if (!isJsonObject(error))
    throw new McpContractError('the response has an error that is no object');
  const { code, message } = error;
  if (typeof code !== 'number' || !Number.isInteger(code) || typeof message !== 'string') {
    throw new McpContractError('the response has an error without a code and a message');
  }
  return new McpRequestError(code, message);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new McpContractError('the MCP server sent a message that is not JSON', { cause: error });
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
