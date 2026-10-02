import { describe, expect, it } from 'vitest';
import { ConfigurationError, parseConfig } from '../../../src/bootstrap/config';

const CONFIG = {
  ollamaEndpoint: '/ollama/main/api/generate',
  model: 'gpt-oss:20b',
  agentStepTimeoutMs: 900_000,
  webSearch: { enabled: true, endpoint: '/overleaf-ai-assistant/mcp/exa/' },
};

describe('parseConfig', () => {
  it('reads an enabled web search with its same-origin endpoint', () => {
    expect(parseConfig(CONFIG)).toEqual({
      ollamaEndpoint: '/ollama/main/api/generate',
      model: 'gpt-oss:20b',
      agentStepTimeoutMs: 900_000,
      webSearch: { endpoint: '/overleaf-ai-assistant/mcp/exa/' },
    });
  });

  it('reads a disabled web search as none', () => {
    expect(
      parseConfig({ ...CONFIG, webSearch: { ...CONFIG.webSearch, enabled: false } }),
    ).toMatchObject({ webSearch: null });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['no web search setting', { ...CONFIG, webSearch: undefined }, '"webSearch" is not an object'],
    [
      'a web search switch that is no boolean',
      { ...CONFIG, webSearch: { ...CONFIG.webSearch, enabled: 'on' } },
      '"webSearch.enabled" must be true or false',
    ],
    [
      'a web search endpoint on another origin',
      { ...CONFIG, webSearch: { ...CONFIG.webSearch, endpoint: 'https://mcp.exa.ai/mcp' } },
      '"webSearch.endpoint" must be a same-origin path',
    ],
    [
      'a protocol-relative web search endpoint',
      { ...CONFIG, webSearch: { ...CONFIG.webSearch, endpoint: '//mcp.exa.ai/mcp' } },
      '"webSearch.endpoint" must be a same-origin path',
    ],
    [
      'a key in the web search setting',
      { ...CONFIG, webSearch: { ...CONFIG.webSearch, apiKey: 'secret' } },
      '"webSearch" has the unknown keys apiKey',
    ],
    ['an unknown key', { ...CONFIG, extra: 1 }, 'the configuration has the unknown keys extra'],
  ])('rejects %s', (_name, data, problem) => {
    expect(() => parseConfig(data)).toThrow(ConfigurationError);
    expect(() => parseConfig(data)).toThrow(problem);
  });
});
