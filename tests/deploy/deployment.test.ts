import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/bootstrap/config';
import { groupOf, itemAt } from '../support/guards';
import { TestFixtureError } from '../support/test-errors';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ENVSH = path.join(ROOT, 'deploy/10-assistant-config.envsh');
const TEMPLATE = path.join(ROOT, 'deploy/nginx.conf.template');
const DOCKERFILE = path.join(ROOT, 'Dockerfile');
const BUNDLE = path.join(ROOT, 'dist/overleaf-ai-assistant.js');
const POLL_ATTEMPTS = 50;
const POLL_INTERVAL_MS = 50;
const PidFile = { Written: 'written', Removed: 'removed' } as const;
const NGINX_START_ATTEMPTS = 3;

for (const binary of ['nginx', 'envsubst']) {
  if (spawnSync('sh', ['-c', `command -v ${binary}`]).status !== 0) {
    throw new TestFixtureError(`the deployment tests need ${binary} on PATH`);
  }
}

function readEnvsubstFilter(): RegExp {
  const match = /NGINX_ENVSUBST_FILTER='([^']+)'/.exec(readFileSync(DOCKERFILE, 'utf8'));
  return new RegExp(groupOf(match, 1, `NGINX_ENVSUBST_FILTER in ${DOCKERFILE}`));
}

const ENVSUBST_FILTER = readEnvsubstFilter();

const VALID_ENV = {
  OVERLEAF_UPSTREAM: '127.0.0.1:8081',
  OLLAMA_UPSTREAM: '127.0.0.1:11434',
  OLLAMA_MODEL: 'gpt-oss:20b',
  ASSISTANT_STEP_TIMEOUT_MS: '900000',
  ASSISTANT_WEB_SEARCH: 'off',
};

const EXA_API_KEY = 'exa-key_1234';
const EXA_UPSTREAM = 'https://mcp.exa.ai/mcp';
const WEB_SEARCH_PATH = '/overleaf-ai-assistant/mcp/exa/';
const CONFIG_JSON = /return 200 '(\{"ollamaEndpoint".*\})';/;

function validate(env: Record<string, string>) {
  const result = spawnSync('sh', ['-c', `. "${ENVSH}" && env`], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  const vars = Object.fromEntries(
    result.stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  return { status: result.status, stderr: result.stderr, vars };
}

function render(vars: Record<string, string>): string {
  const names = Object.keys(vars)
    .filter((name) => ENVSUBST_FILTER.test(name))
    .map((name) => `\${${name}}`)
    .join(' ');
  return execFileSync('envsubst', [names], {
    input: readFileSync(TEMPLATE, 'utf8'),
    env: vars,
    encoding: 'utf8',
  });
}

describe('deployment configuration', () => {
  it('accepts the example configuration', () => {
    const example = Object.fromEntries(
      readFileSync(path.join(ROOT, '.env.example'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    expect(validate(example).status).toBe(0);
  });

  it('derives the proxy timeout from the request timeout', () => {
    const { status, vars } = validate(VALID_ENV);
    expect(status).toBe(0);
    expect(vars).toMatchObject({
      OLLAMA_PROXY_TIMEOUT_S: '930',
      ASSISTANT_OLLAMA_PATH: '/ollama/main/api/generate',
    });
  });

  it('turns web search on or off and takes an optional Exa key only when it is on', () => {
    expect(validate(VALID_ENV).vars).toMatchObject({
      ASSISTANT_WEB_SEARCH_ENABLED: 'false',
      ASSISTANT_WEB_SEARCH_PATH: WEB_SEARCH_PATH,
      ASSISTANT_EXA_API_KEY: '',
    });
    const anonymous = validate({ ...VALID_ENV, ASSISTANT_WEB_SEARCH: 'on' });
    expect(anonymous.status).toBe(0);
    expect(anonymous.vars).toMatchObject({ ASSISTANT_WEB_SEARCH_ENABLED: 'true' });
    const keyed = validate({
      ...VALID_ENV,
      ASSISTANT_WEB_SEARCH: 'on',
      ASSISTANT_EXA_API_KEY: EXA_API_KEY,
    });
    expect(keyed.status).toBe(0);
    expect(keyed.vars).toMatchObject({ ASSISTANT_EXA_API_KEY: EXA_API_KEY });
  });

  it.each([
    [
      'missing Overleaf upstream',
      { ...VALID_ENV, OVERLEAF_UPSTREAM: '' },
      'OVERLEAF_UPSTREAM is required',
    ],
    ['upstream without port', { ...VALID_ENV, OLLAMA_UPSTREAM: 'ollama' }, 'must be host:port'],
    ['missing model', { ...VALID_ENV, OLLAMA_MODEL: '' }, 'OLLAMA_MODEL is required'],
    ['model with quotes', { ...VALID_ENV, OLLAMA_MODEL: 'a"b' }, 'unsupported characters'],
    [
      'missing request timeout',
      { ...VALID_ENV, ASSISTANT_STEP_TIMEOUT_MS: '' },
      'ASSISTANT_STEP_TIMEOUT_MS is required',
    ],
    ['non-numeric timeout', { ...VALID_ENV, ASSISTANT_STEP_TIMEOUT_MS: '15m' }, 'positive integer'],
    [
      'an unset web search switch',
      { ...VALID_ENV, ASSISTANT_WEB_SEARCH: '' },
      'ASSISTANT_WEB_SEARCH is required (on or off)',
    ],
    [
      'a web search switch other than on or off',
      { ...VALID_ENV, ASSISTANT_WEB_SEARCH: 'yes' },
      "ASSISTANT_WEB_SEARCH must be on or off, got 'yes'",
    ],
    [
      'an Exa key while web search is off',
      { ...VALID_ENV, ASSISTANT_EXA_API_KEY: EXA_API_KEY },
      'ASSISTANT_EXA_API_KEY is set, but ASSISTANT_WEB_SEARCH is off',
    ],
    [
      'an Exa key that could break the configuration',
      { ...VALID_ENV, ASSISTANT_WEB_SEARCH: 'on', ASSISTANT_EXA_API_KEY: 'key"; deny all;' },
      'ASSISTANT_EXA_API_KEY contains characters other than letters, digits, - and _',
    ],
  ])('fails start-up on %s', (_name, env, message) => {
    const { status, stderr } = validate(env);
    expect(status).not.toBe(0);
    expect(stderr).toContain(message);
    expect(stderr).not.toContain('deny all');
  });

  it('renders a config.json the bundle accepts', () => {
    const config = CONFIG_JSON.exec(render(validate(VALID_ENV).vars));
    expect(parseConfig(JSON.parse(groupOf(config, 1, 'rendered config.json')))).toEqual({
      ollamaEndpoint: '/ollama/main/api/generate',
      model: 'gpt-oss:20b',
      agentStepTimeoutMs: 900000,
      webSearch: null,
    });
  });

  it('publishes only the switch and the same-origin path of web search, never the key', () => {
    const rendered = render(
      validate({ ...VALID_ENV, ASSISTANT_WEB_SEARCH: 'on', ASSISTANT_EXA_API_KEY: EXA_API_KEY })
        .vars,
    );
    const config = groupOf(CONFIG_JSON.exec(rendered), 1, 'rendered config.json');
    expect(parseConfig(JSON.parse(config))).toMatchObject({
      webSearch: { endpoint: WEB_SEARCH_PATH },
    });
    expect(config).not.toContain(EXA_API_KEY);
    expect(rendered).toContain(`proxy_set_header x-api-key "${EXA_API_KEY}";`);
    expect(rendered).toContain(`proxy_pass ${EXA_UPSTREAM};`);
  });

  it('leaves nginx variables untouched and hard-codes no address', () => {
    const rendered = render(validate(VALID_ENV).vars);
    expect(rendered).toContain('$proxy_add_x_forwarded_for');
    expect(rendered).not.toMatch(/\$\{/);
    expect(readFileSync(TEMPLATE, 'utf8')).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(readFileSync(TEMPLATE, 'utf8')).not.toMatch(
      /unsafe-(inline|eval)|proxy_hide_header\s+Content-Security-Policy/i,
    );
  });

  it('ships a bundle that runs under a CSP without unsafe-eval', () => {
    expect(readFileSync(BUNDLE, 'utf8')).not.toMatch(/\beval\(|\bnew Function\(|\bFunction\(['"`]/);
  });
});

const OVERLEAF_CSP =
  "script-src 'nonce-Ab+/cd==' 'unsafe-inline' 'strict-dynamic' https: 'report-sample'; object-src 'none'";

const SESSION_COOKIE = 'overleaf_session2=signed-in';
const SESSION_ROUTE = '/user/personal_info';
const OLLAMA_PATH = '/ollama/main/api/generate';
const OLLAMA_BURST = 30;
const WEB_SEARCH_BURST = 10;

interface UpstreamRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

describe('nginx proxy', () => {
  const overleafRequests: UpstreamRequest[] = [];
  const ollamaRequests: UpstreamRequest[] = [];
  const exaRequests: UpstreamRequest[] = [];
  let finishExa: () => void = () => undefined;
  const exaFinish = new Promise<void>((resolve) => {
    finishExa = resolve;
  });
  let overleafServer: Server;
  let ollamaServer: Server;
  let exaServer: Server;
  let base = '';
  let prefix = '';

  const signedIn = (headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: SESSION_COOKIE,
      Origin: base,
      ...headers,
    },
    body: '{}',
  });
  const sessionChecks = () => overleafRequests.filter(({ url }) => url === SESSION_ROUTE);
  const upstreamCalls = () => ollamaRequests.length + exaRequests.length;

  beforeAll(() => {
    prefix = createPrefix();
  });

  afterAll(async () => {
    if (prefix !== '') await removeNginx(prefix);
  });

  beforeAll(async () => {
    overleafServer = await listenRecording(overleafRequests, (req, res) => {
      if (req.url === '/status') {
        res.end('web is alive');
        return;
      }
      if (req.url === SESSION_ROUTE) {
        const signedInCookie =
          req.headers.cookie === SESSION_COOKIE && req.headers.accept === 'application/json';
        res.writeHead(signedInCookie ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end(signedInCookie ? '{"id":"1"}' : '');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      if (req.url !== '/without-csp') res.setHeader('Content-Security-Policy', OVERLEAF_CSP);
      res.end('<html><body><div role="textbox"></div></body></html>');
    });
    ollamaServer = await listenRecording(ollamaRequests, (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(req.url === '/api/version' ? '{"version":"0"}' : '{"response":"{}"}');
    });

    exaServer = await listenRecording(exaRequests, (_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Mcp-Session-Id': 'session-1',
        'Set-Cookie': '__cf_bm=tracker; Path=/',
        'Strict-Transport-Security': 'max-age=63072000',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id',
        'Access-Control-Max-Age': '600',
      });
      res.write('event: message\ndata: {"first":true}\n\n');
      void exaFinish.then(() => {
        res.end('event: message\ndata: {"last":true}\n\n');
      });
    });

    const { vars } = validate({
      ...VALID_ENV,
      OVERLEAF_UPSTREAM: `127.0.0.1:${String(portOf(overleafServer))}`,
      OLLAMA_UPSTREAM: `127.0.0.1:${String(portOf(ollamaServer))}`,
      ASSISTANT_WEB_SEARCH: 'on',
      ASSISTANT_EXA_API_KEY: EXA_API_KEY,
    });
    base = await startNginx(prefix, pointWebSearchAt(render(vars), exaServer));
    await waitUntilHealthy(base);
  });

  afterAll(async () => {
    finishExa();
    await Promise.all([
      closeServer(overleafServer),
      closeServer(ollamaServer),
      closeServer(exaServer),
    ]);
  });

  it('injects the assistant with the nonce of the unchanged upstream CSP', async () => {
    const response = await fetch(`${base}/project/1`);
    expect(await response.text()).toContain(
      '<script nonce="Ab+/cd==" src="/overleaf-ai-assistant.js"></script></body>',
    );
    expect(response.headers.get('content-security-policy')).toBe(OVERLEAF_CSP);
  });

  it('injects the assistant without a nonce when Overleaf sends no CSP', async () => {
    const response = await fetch(`${base}/without-csp`);
    expect(await response.text()).toContain(
      '<script nonce="" src="/overleaf-ai-assistant.js"></script></body>',
    );
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it('serves the bundle uncached and a valid configuration', async () => {
    const bundle = await fetch(`${base}/overleaf-ai-assistant.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get('cache-control')).toContain('no-store');
    const config = await fetch(`${base}/overleaf-ai-assistant/config.json`);
    expect(parseConfig(await config.json())).toMatchObject({ model: 'gpt-oss:20b' });
  });

  it('exposes only POST /api/generate of Ollama', async () => {
    const ok = await fetch(`${base}${OLLAMA_PATH}`, signedIn());
    expect(ok.status).toBe(200);
    const request = itemAt(ollamaRequests, -1, 'Ollama request');
    expect(request).toMatchObject({ method: 'POST', url: '/api/generate', body: '{}' });
    expect(request.headers).not.toHaveProperty('origin');
    expect(request.headers.host).toMatch(/^127\.0\.0\.1:\d+$/);
    const count = ollamaRequests.length;
    expect(
      (await fetch(`${base}${OLLAMA_PATH}`, { headers: { Cookie: SESSION_COOKIE } })).status,
    ).toBe(403);
    await fetch(`${base}/ollama/main/api/pull`, signedIn());
    expect(ollamaRequests).toHaveLength(count);
  });

  it('accepts a JSON body with a charset and refuses any other body type with 415', async () => {
    const withCharset = await fetch(
      `${base}${OLLAMA_PATH}`,
      signedIn({ 'Content-Type': 'application/json; charset=utf-8' }),
    );
    expect(withCharset.status).toBe(200);
    const count = upstreamCalls();
    const checks = sessionChecks().length;
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonp']) {
      for (const path of [OLLAMA_PATH, WEB_SEARCH_PATH]) {
        expect((await fetch(`${base}${path}`, signedIn({ 'Content-Type': type }))).status).toBe(
          415,
        );
      }
    }
    const untyped = await fetch(`${base}${OLLAMA_PATH}`, {
      method: 'POST',
      headers: { Cookie: SESSION_COOKIE },
      body: new Uint8Array([123, 125]),
    });
    expect(untyped.status).toBe(415);
    expect(upstreamCalls()).toBe(count);
    expect(sessionChecks()).toHaveLength(checks);
  });

  it('refuses requests from another origin before checking the session', async () => {
    const count = upstreamCalls();
    const checks = sessionChecks().length;
    for (const origin of ['http://evil.test', 'null', base.replace('127.0.0.1', 'localhost')]) {
      for (const path of [OLLAMA_PATH, WEB_SEARCH_PATH]) {
        expect((await fetch(`${base}${path}`, signedIn({ Origin: origin }))).status).toBe(403);
      }
    }
    expect(upstreamCalls()).toBe(count);
    expect(sessionChecks()).toHaveLength(checks);
  });

  it('accepts the same host behind a proxy that terminates HTTPS', async () => {
    const httpsOrigin = base.replace('http://', 'https://');
    for (const path of [OLLAMA_PATH, WEB_SEARCH_PATH]) {
      expect((await fetch(`${base}${path}`, signedIn({ Origin: httpsOrigin }))).status).not.toBe(
        403,
      );
    }
  });

  it('accepts requests without an Origin, as a same-origin client may send them', async () => {
    const response = await fetch(`${base}${OLLAMA_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: SESSION_COOKIE },
      body: '{}',
    });
    expect(response.status).toBe(200);
  });

  it('refuses requests without a signed-in Overleaf session and never reaches the upstreams', async () => {
    const count = upstreamCalls();
    for (const cookie of [undefined, 'overleaf_session2=expired']) {
      for (const path of [OLLAMA_PATH, WEB_SEARCH_PATH]) {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Origin: base,
        };
        if (cookie !== undefined) headers.Cookie = cookie;
        expect(
          (await fetch(`${base}${path}`, { method: 'POST', headers, body: '{}' })).status,
        ).toBe(401);
      }
    }
    expect(upstreamCalls()).toBe(count);
    expect((await fetch(`${base}/overleaf-ai-assistant/session`)).status).toBe(404);
  });

  it('checks the session with a bodiless GET to Overleaf that carries only the cookie', async () => {
    await fetch(
      `${base}${OLLAMA_PATH}`,
      signedIn({ Authorization: 'Bearer user-token', 'X-Csrf-Token': 'csrf-1' }),
    );
    const check = itemAt(sessionChecks(), -1, 'session check');
    expect(check).toMatchObject({ method: 'GET', body: '' });
    expect(check.headers).toMatchObject({ cookie: SESSION_COOKIE, accept: 'application/json' });
    for (const header of [
      'authorization',
      'x-csrf-token',
      'origin',
      'content-type',
      'content-length',
      'transfer-encoding',
    ]) {
      expect(check.headers).not.toHaveProperty(header);
    }
  });

  it("forwards requests to the upstreams without the browser's Overleaf credentials", async () => {
    const credentials = {
      Cookie: SESSION_COOKIE,
      Authorization: 'Bearer user-token',
      'X-Csrf-Token': 'csrf-1',
    };
    await fetch(`${base}${OLLAMA_PATH}`, signedIn(credentials));
    await fetch(`${base}/healthz/ollama`, { headers: credentials });
    await fetch(`${base}/healthz/overleaf`, { headers: credentials });
    const forwarded = [
      ...ollamaRequests.slice(-2),
      itemAt(overleafRequests, -1, 'Overleaf health request'),
    ];
    for (const request of forwarded) {
      for (const header of ['cookie', 'authorization', 'x-csrf-token']) {
        expect(request.headers).not.toHaveProperty(header);
      }
    }
  });

  it("forwards signed-in web search to Exa without the browser's credentials and with the server key", async () => {
    const response = await fetch(
      `${base}${WEB_SEARCH_PATH}`,
      signedIn({
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': 'session-1',
        Authorization: 'Bearer user-token',
        Referer: `${base}/project/1`,
        'X-Csrf-Token': 'csrf-1',
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBe('session-1');
    for (const header of [
      'set-cookie',
      'strict-transport-security',
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-allow-headers',
      'access-control-allow-methods',
      'access-control-expose-headers',
      'access-control-max-age',
    ]) {
      expect(response.headers.get(header)).toBeNull();
    }
    const request = itemAt(exaRequests, -1, 'Exa request');
    expect(request).toMatchObject({ method: 'POST', url: '/mcp' });
    expect(request.headers).toMatchObject({
      'x-api-key': EXA_API_KEY,
      'mcp-session-id': 'session-1',
      accept: 'application/json, text/event-stream',
    });
    for (const header of ['cookie', 'authorization', 'origin', 'referer', 'x-csrf-token']) {
      expect(request.headers).not.toHaveProperty(header);
    }
    const reader = response.body?.getReader();
    if (reader === undefined) throw new TestFixtureError('the web search answer has no body');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('{"first":true}');
    finishExa();
    let rest = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(rest).toContain('{"last":true}');
  });

  it('accepts only POST for web search and keeps the key out of config.json', async () => {
    const count = exaRequests.length;
    expect(
      (await fetch(`${base}${WEB_SEARCH_PATH}`, { headers: { Cookie: SESSION_COOKIE } })).status,
    ).toBe(403);
    expect(exaRequests).toHaveLength(count);
    const config = await (await fetch(`${base}/overleaf-ai-assistant/config.json`)).text();
    expect(parseConfig(JSON.parse(config))).toMatchObject({
      webSearch: { endpoint: WEB_SEARCH_PATH },
    });
    expect(config).not.toContain(EXA_API_KEY);
  });

  it('reports process and upstream health separately', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${base}/healthz/overleaf`)).text()).toBe('web is alive');
    expect((await fetch(`${base}/healthz/ollama`)).status).toBe(200);
    const closed = closeServer(ollamaServer);
    ollamaServer.closeAllConnections();
    await closed;
    expect((await fetch(`${base}/healthz/ollama`)).status).toBe(502);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it.each([
    [OLLAMA_PATH, OLLAMA_BURST],
    [WEB_SEARCH_PATH, WEB_SEARCH_BURST],
  ])('limits the request rate to %s per client address', async (path, burst) => {
    const count = upstreamCalls();
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= burst + 1; attempt += 1) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: '{}',
      });
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(true);
    expect(upstreamCalls()).toBe(count);
  });
});

describe('nginx proxy with web search off', () => {
  let exaServer: Server;
  let exaCalls = 0;
  let base = '';
  let prefix = '';

  beforeAll(() => {
    prefix = createPrefix();
  });

  afterAll(async () => {
    if (prefix !== '') await removeNginx(prefix);
  });

  beforeAll(async () => {
    exaServer = await listen((_req, res) => {
      exaCalls += 1;
      res.end();
    });
    base = await startNginx(prefix, pointWebSearchAt(render(validate(VALID_ENV).vars), exaServer));
    await waitUntilHealthy(base);
  });

  afterAll(async () => {
    await closeServer(exaServer);
  });

  it('answers web search with 404 and never reaches Exa', async () => {
    const response = await fetch(`${base}${WEB_SEARCH_PATH}`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
    expect(exaCalls).toBe(0);
    const config = await fetch(`${base}/overleaf-ai-assistant/config.json`);
    expect(parseConfig(await config.json())).toMatchObject({ webSearch: null });
  });
});

function createPrefix(): string {
  const prefix = mkdtempSync(path.join(tmpdir(), 'ola-nginx-'));
  chmodSync(prefix, 0o755);
  mkdirSync(path.join(prefix, 'html'));
  copyFileSync(BUNDLE, path.join(prefix, 'html/overleaf-ai-assistant.js'));
  return prefix;
}

function pointWebSearchAt(rendered: string, server: Server): string {
  if (!rendered.includes(`proxy_pass ${EXA_UPSTREAM};`)) {
    throw new TestFixtureError(`the rendered configuration does not proxy to ${EXA_UPSTREAM}`);
  }
  return rendered.replace(
    `proxy_pass ${EXA_UPSTREAM};`,
    `proxy_pass http://127.0.0.1:${String(portOf(server))}/mcp;`,
  );
}

async function removeNginx(prefix: string): Promise<void> {
  try {
    if (existsSync(pidFileOf(prefix))) await stopNginx(prefix);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
}

async function stopNginx(prefix: string): Promise<void> {
  const stopped = spawnSync(
    'nginx',
    ['-q', '-p', prefix, '-c', path.join(prefix, 'nginx.conf'), '-s', 'stop'],
    { encoding: 'utf8' },
  );
  if (stopped.status !== 0) {
    throw new TestFixtureError(`nginx in ${prefix} refused to stop: ${stopped.stderr}`);
  }
  await waitForPidFile(prefix, PidFile.Removed);
}

function pidFileOf(prefix: string): string {
  return path.join(prefix, 'nginx.pid');
}

async function record(request: IncomingMessage): Promise<UpstreamRequest> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return { method: request.method, url: request.url, headers: request.headers, body };
}

function listenRecording(
  requests: UpstreamRequest[],
  respond: (request: UpstreamRequest, response: ServerResponse) => void,
): Promise<Server> {
  return listen((req, res) => {
    void record(req).then((request) => {
      requests.push(request);
      respond(request, res);
    });
  });
}

function listen(handler: Parameters<typeof createServer>[1]): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(handler).listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new TestFixtureError('the test server listens on no TCP port');
  }
  return address.port;
}

async function findFreePort(): Promise<number> {
  const probe = await listen(() => undefined);
  const port = portOf(probe);
  await closeServer(probe);
  return port;
}

function configureNginx(prefix: string, rendered: string, port: number): string {
  return rendered
    .replace('listen 80;', `listen 127.0.0.1:${String(port)};`)
    .replace('root /usr/share/nginx/html;', `root ${path.join(prefix, 'html')};`)
    .replace(
      'worker_processes auto;',
      `worker_processes 1;\npid ${pidFileOf(prefix)};\nerror_log ${prefix}/error.log warn;`,
    )
    .replace(
      'http {',
      `http {\n    access_log off;\n    client_body_temp_path ${prefix};\n    proxy_temp_path ${prefix};`,
    );
}

async function startNginx(prefix: string, rendered: string): Promise<string> {
  const conf = path.join(prefix, 'nginx.conf');
  for (let attempt = 1; attempt <= NGINX_START_ATTEMPTS; attempt += 1) {
    const port = await findFreePort();
    writeFileSync(conf, configureNginx(prefix, rendered, port));
    execFileSync('nginx', ['-t', '-q', '-p', prefix, '-c', conf]);
    const started = spawnSync('nginx', ['-p', prefix, '-c', conf], { encoding: 'utf8' });
    if (started.status === 0) {
      await waitForPidFile(prefix, PidFile.Written);
      return `http://127.0.0.1:${String(port)}`;
    }
    if (!started.stderr.includes('Address already in use')) {
      throw new TestFixtureError(`nginx did not start: ${started.stderr}`);
    }
  }
  throw new TestFixtureError(
    `nginx found no free port in ${String(NGINX_START_ATTEMPTS)} attempts`,
  );
}

async function waitForPidFile(
  prefix: string,
  expected: (typeof PidFile)[keyof typeof PidFile],
): Promise<void> {
  const pidFile = pidFileOf(prefix);
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (existsSync(pidFile) === (expected === PidFile.Written)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new TestFixtureError(`the pid file of nginx in ${prefix} was not ${expected}`);
}

async function waitUntilHealthy(base: string): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const healthy = await fetch(`${base}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new TestFixtureError(`the proxy at ${base} did not become healthy`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}
