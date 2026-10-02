import { NamedError } from '../domain/errors';

export interface WebSearchConfig {
  readonly endpoint: string;
}

export interface AssistantConfig {
  readonly ollamaEndpoint: string;
  readonly model: string;
  readonly agentStepTimeoutMs: number;
  readonly webSearch: WebSearchConfig | null;
}

const CONFIG_URL = '/overleaf-ai-assistant/config.json';
const CONFIG_KEYS = ['ollamaEndpoint', 'model', 'agentStepTimeoutMs', 'webSearch'];
const WEB_SEARCH_KEYS = ['enabled', 'endpoint'];
const SAME_ORIGIN_PATH = /^\/(?!\/)/;

export class ConfigurationError extends NamedError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`Invalid assistant configuration: ${message}`, options);
  }
}

export function parseConfig(data: unknown): AssistantConfig {
  const fields = getFields(data, CONFIG_KEYS, 'the configuration');
  return Object.freeze({
    ollamaEndpoint: getSameOriginPath(fields, 'ollamaEndpoint'),
    model: getText(fields, 'model'),
    agentStepTimeoutMs: getPositiveInteger(fields, 'agentStepTimeoutMs'),
    webSearch: parseWebSearch(fields.get('webSearch')),
  });
}

function parseWebSearch(data: unknown): WebSearchConfig | null {
  const fields = getFields(data, WEB_SEARCH_KEYS, '"webSearch"');
  const enabled = fields.get('enabled');
  if (typeof enabled !== 'boolean') {
    throw new ConfigurationError('"webSearch.enabled" must be true or false');
  }
  const endpoint = getSameOriginPath(fields, 'endpoint', 'webSearch.');
  return enabled ? Object.freeze({ endpoint }) : null;
}

function getFields(data: unknown, keys: readonly string[], name: string): Map<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ConfigurationError(`${name} is not an object`);
  }
  const fields = new Map(Object.entries(data));
  const unknown = [...fields.keys()].filter((key) => !keys.includes(key));
  if (unknown.length) {
    throw new ConfigurationError(`${name} has the unknown keys ${unknown.join(', ')}`);
  }
  return fields;
}

function getSameOriginPath(fields: Map<string, unknown>, key: string, scope = ''): string {
  const path = getText(fields, key, scope);
  if (!SAME_ORIGIN_PATH.test(path)) {
    throw new ConfigurationError(`"${scope}${key}" must be a same-origin path`);
  }
  return path;
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

function getText(fields: Map<string, unknown>, key: string, scope = ''): string {
  const value = fields.get(key);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigurationError(`"${scope}${key}" must be a non-empty string`);
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
