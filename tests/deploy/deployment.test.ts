import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/bootstrap/config';
import { MIN_CONTEXT_TOKENS } from '../../src/infrastructure/ollama/assistant-protocol';
import { TestFixtureError } from '../support/test-errors';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ENVSH = path.join(ROOT, 'deploy/10-assistant-config.envsh');
const TEMPLATE = path.join(ROOT, 'deploy/nginx.conf.template');
const HEALTH_ATTEMPTS = 50;
const HEALTH_INTERVAL_MS = 50;
const hasBinary = (name: string) => spawnSync('sh', ['-c', `command -v ${name}`]).status === 0;

const VALID_ENV = {
  OVERLEAF_UPSTREAM: '127.0.0.1:8081',
  OLLAMA_UPSTREAM: '127.0.0.1:11434',
  OLLAMA_MODEL: 'gpt-oss:20b',
};

function validate(env: Record<string, string>) {
  const result = spawnSync('sh', ['-c', `. "${ENVSH}" && env`], {
    env: { PATH: process.env.PATH ?? '', ...env },
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
    .filter((name) => /^(OVERLEAF_|OLLAMA_|ASSISTANT_)/.test(name))
    .map((name) => `\${${name}}`)
    .join(' ');
  return execFileSync('envsubst', [names], {
    input: readFileSync(TEMPLATE, 'utf8'),
    env: vars,
    encoding: 'utf8',
  });
}

describe('deployment configuration', () => {
  it('refuses the same minimum context window as the bundle', () => {
    expect(readFileSync(ENVSH, 'utf8')).toContain(
      `ASSISTANT_MIN_CONTEXT_TOKENS=${String(MIN_CONTEXT_TOKENS)}`,
    );
  });

  it('applies documented defaults and derives the proxy timeout', () => {
    const { status, vars } = validate(VALID_ENV);
    expect(status).toBe(0);
    expect(vars).toMatchObject({
      OLLAMA_REQUEST_TIMEOUT_MS: '900000',
      OLLAMA_CONTEXT_TOKENS: '128000',
      OLLAMA_PROXY_TIMEOUT_S: '930',
      ASSISTANT_OLLAMA_PATH: '/ollama/main/api/generate',
    });
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
    ['non-numeric timeout', { ...VALID_ENV, OLLAMA_REQUEST_TIMEOUT_MS: '15m' }, 'positive integer'],
    ['too small context window', { ...VALID_ENV, OLLAMA_CONTEXT_TOKENS: '8000' }, 'at least'],
    [
      'non-numeric context window',
      { ...VALID_ENV, OLLAMA_CONTEXT_TOKENS: '128k' },
      'positive integer',
    ],
  ])('fails start-up on %s', (_name, env, message) => {
    const { status, stderr } = validate(env);
    expect(status).not.toBe(0);
    expect(stderr).toContain(message);
  });

  it.runIf(hasBinary('envsubst'))('renders a config.json the bundle accepts', () => {
    const config = /return 200 '(\{"ollamaEndpoint".*\})';/.exec(render(validate(VALID_ENV).vars));
    expect(parseConfig(JSON.parse(config![1]!))).toEqual({
      ollamaEndpoint: '/ollama/main/api/generate',
      model: 'gpt-oss:20b',
      requestTimeoutMs: 900000,
      contextTokens: 128000,
    });
  });

  it.runIf(hasBinary('envsubst'))(
    'leaves nginx variables untouched and hard-codes no address',
    () => {
      const rendered = render(validate(VALID_ENV).vars);
      expect(rendered).toContain('$proxy_add_x_forwarded_for');
      expect(rendered).not.toMatch(/\$\{/);
      expect(readFileSync(TEMPLATE, 'utf8')).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(readFileSync(TEMPLATE, 'utf8')).not.toMatch(/unsafe-(inline|eval)|proxy_hide_header/);
    },
  );
});

const OVERLEAF_CSP =
  "script-src 'nonce-Ab+/cd==' 'unsafe-inline' 'strict-dynamic' https: 'report-sample'; object-src 'none'";

describe.runIf(hasBinary('nginx') && hasBinary('envsubst'))('nginx proxy', () => {
  const servers: Server[] = [];
  const ollamaRequests: { method: string; url: string; host: string; origin: string }[] = [];
  let base = '';
  let prefix = '';

  const listen = (handler: Parameters<typeof createServer>[1]): Promise<number> =>
    new Promise((resolve) => {
      const server = createServer(handler).listen(0, '127.0.0.1', () => {
        resolve((server.address() as AddressInfo).port);
      });
      servers.push(server);
    });

  beforeAll(async () => {
    const overleaf = await listen((req, res) => {
      if (req.url === '/status') {
        res.end('web is alive');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      if (req.url !== '/without-csp') res.setHeader('Content-Security-Policy', OVERLEAF_CSP);
      res.end('<html><body><div role="textbox"></div></body></html>');
    });
    const ollama = await listen((req, res) => {
      ollamaRequests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        host: req.headers.host ?? '',
        origin: req.headers.origin ?? '',
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(req.url === '/api/version' ? '{"version":"0"}' : '{"response":"{}"}');
    });
    const port = await listen(() => undefined);
    servers.pop()?.close();

    prefix = mkdtempSync(path.join(tmpdir(), 'ola-nginx-'));
    chmodSync(prefix, 0o755);
    mkdirSync(path.join(prefix, 'html'));
    copyFileSync(
      path.join(ROOT, 'dist/overleaf-ai-assistant.js'),
      path.join(prefix, 'html/overleaf-ai-assistant.js'),
    );
    const { vars } = validate({
      ...VALID_ENV,
      OVERLEAF_UPSTREAM: `127.0.0.1:${String(overleaf)}`,
      OLLAMA_UPSTREAM: `127.0.0.1:${String(ollama)}`,
    });
    const conf = render(vars)
      .replace('listen 80;', `listen 127.0.0.1:${String(port)};`)
      .replace('root /usr/share/nginx/html;', `root ${path.join(prefix, 'html')};`)
      .replace(
        'worker_processes auto;',
        `worker_processes 1;\npid ${prefix}/nginx.pid;\nerror_log ${prefix}/error.log;`,
      )
      .replace(
        'http {',
        `http {\n    access_log off;\n    client_body_temp_path ${prefix};\n    proxy_temp_path ${prefix};`,
      );
    writeFileSync(path.join(prefix, 'nginx.conf'), conf);
    execFileSync('nginx', ['-t', '-q', '-p', prefix, '-c', path.join(prefix, 'nginx.conf')]);
    execFileSync('nginx', ['-p', prefix, '-c', path.join(prefix, 'nginx.conf')]);
    base = `http://127.0.0.1:${String(port)}`;
    await waitUntilHealthy(base);
  });

  afterAll(async () => {
    if (prefix) {
      spawnSync('nginx', ['-p', prefix, '-c', path.join(prefix, 'nginx.conf'), '-s', 'stop']);
      rmSync(prefix, { recursive: true, force: true });
    }
    await Promise.all(servers.map((server) => closeServer(server)));
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
    const ok = await fetch(`${base}/ollama/main/api/generate`, {
      method: 'POST',
      headers: { Origin: 'http://evil.test' },
      body: '{}',
    });
    expect(ok.status).toBe(200);
    expect(ollamaRequests.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/generate',
      origin: '',
    });
    expect(ollamaRequests.at(-1)!.host).toMatch(/^127\.0\.0\.1:\d+$/);
    expect((await fetch(`${base}/ollama/main/api/generate`)).status).toBe(403);
    const count = ollamaRequests.length;
    await fetch(`${base}/ollama/main/api/pull`, { method: 'POST', body: '{}' });
    expect(ollamaRequests.filter((r) => r.url === '/api/pull')).toHaveLength(0);
    expect(ollamaRequests).toHaveLength(count);
  });

  it('reports process and upstream health separately', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${base}/healthz/overleaf`)).text()).toBe('web is alive');
    expect((await fetch(`${base}/healthz/ollama`)).status).toBe(200);
    servers[1]!.close();
    servers[1]!.closeAllConnections();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await fetch(`${base}/healthz/ollama`)).status).toBe(502);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

async function waitUntilHealthy(base: string): Promise<void> {
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
    const healthy = await fetch(`${base}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
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
