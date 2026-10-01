import { NamedError } from '../domain/errors';

export interface AssistantConfig {
  readonly ollamaEndpoint: string;
  readonly model: string;
  readonly agentStepTimeoutMs: number;
}

const CONFIG_URL = '/overleaf-ai-assistant/config.json';
const CONFIG_KEYS = ['ollamaEndpoint', 'model', 'agentStepTimeoutMs'];

export class ConfigurationError extends NamedError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`Invalid assistant configuration: ${message}`, options);
  }
}

export function parseConfig(data: unknown): AssistantConfig {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ConfigurationError('not an object');
  }
  const fields = new Map(Object.entries(data));
  const unknown = [...fields.keys()].filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length) throw new ConfigurationError(`unknown keys ${unknown.join(', ')}`);

  const ollamaEndpoint = getText(fields, 'ollamaEndpoint');
  if (!/^\/(?!\/)/.test(ollamaEndpoint)) {
    throw new ConfigurationError('"ollamaEndpoint" must be a same-origin path');
  }
  return Object.freeze({
    ollamaEndpoint,
    model: getText(fields, 'model'),
    agentStepTimeoutMs: getPositiveInteger(fields, 'agentStepTimeoutMs'),
  });
}

export async function loadConfig(fetchFn: typeof fetch): Promise<AssistantConfig> {
  const response = await fetchConfig(fetchFn);
  if (!response.ok) {
    throw new ConfigurationError(`${CONFIG_URL} answered HTTP ${String(response.status)}`);
  }
  return parseConfig(await readJson(response));
}

async function fetchConfig(fetchFn: typeof fetch): Promise<Response> {
  try {
    return await fetchFn(CONFIG_URL, { cache: 'no-store' });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ConfigurationError(`${CONFIG_URL} could not be loaded`, { cause: error });
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ConfigurationError(`${CONFIG_URL} is not JSON`, { cause: error });
  }
}

function getText(fields: Map<string, unknown>, key: string): string {
  const value = fields.get(key);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigurationError(`"${key}" must be a non-empty string`);
  }
  return value;
}

function getPositiveInteger(fields: Map<string, unknown>, key: string): number {
  const value = fields.get(key);
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(`"${key}" must be a positive integer`);
  }
  return value;
}
