import { describe, expect, it } from 'vitest';
import { OllamaAssistant } from '../../../src/infrastructure/ollama/ollama-assistant';
import { OllamaClient } from '../../../src/infrastructure/ollama/ollama-client';
import { MIN_CONTEXT_TOKENS } from '../../../src/infrastructure/ollama/assistant-protocol';
import {
  AssistantProtocolError,
  AssistantTimeoutError,
  AssistantTransportError,
} from '../../../src/ports/errors';
import { FakeOllama } from '../../support/fake-ollama';
import { createDocumentSnapshot } from '../../../src/domain/document';

const config = {
  endpoint: '/ollama/main/api/generate',
  model: 'm',
  contextTokens: 4_096,
  timeoutMs: 50,
};
const make = (ollama: FakeOllama) => {
  const client = new OllamaClient(config, ollama.fetch as never);
  return { client, assistant: new OllamaAssistant(client, MIN_CONTEXT_TOKENS) };
};
const plan = (value: unknown) => ({ response: JSON.stringify(value) });

describe('OllamaClient', () => {
  it('posts the configured request and returns the raw response', async () => {
    const ollama = new FakeOllama().reply({ response: 'raw' });
    await expect(make(ollama).client.generate({ system: 'S', prompt: 'P' })).resolves.toBe('raw');
    expect(ollama.calls[0]).toEqual({
      url: '/ollama/main/api/generate',
      body: {
        model: 'm',
        stream: false,
        keep_alive: -1,
        system: 'S',
        prompt: 'P',
        options: { num_ctx: 4_096, temperature: 0.2 },
      },
    });
  });

  it('reports HTTP errors as transport errors', async () => {
    const ollama = new FakeOllama().reply({ status: 502 });
    await expect(make(ollama).client.generate({ system: 'S', prompt: 'P' })).rejects.toThrow(
      AssistantTransportError,
    );
  });

  it('reports a body that is not JSON as a transport error', async () => {
    const client = new OllamaClient(config, () => Promise.resolve(new Response('<html>')));
    await expect(client.generate({ system: 'S', prompt: 'P' })).rejects.toThrow('not JSON');
  });

  it('reports network failures while loading the model as transport errors', async () => {
    const client = new OllamaClient(config, () => Promise.reject(new TypeError('offline')));
    await expect(client.loadModel()).rejects.toThrow(AssistantTransportError);
  });

  it('reports network failures as transport errors', async () => {
    const client = new OllamaClient(config, () => Promise.reject(new TypeError('offline')));
    await expect(client.generate({ system: 'S', prompt: 'P' })).rejects.toThrow(
      AssistantTransportError,
    );
  });

  it('reports a malformed transport body', async () => {
    const client = new OllamaClient(config, () => Promise.resolve(new Response('{"done":true}')));
    await expect(client.generate({ system: 'S', prompt: 'P' })).rejects.toThrow(
      'no "response" field',
    );
  });

  it('times out', async () => {
    const ollama = new FakeOllama().reply({ hang: true });
    await expect(make(ollama).client.generate({ system: 'S', prompt: 'P' })).rejects.toThrow(
      new AssistantTimeoutError('Ollama did not respond within 0 seconds.'),
    );
  });

  it('does not disguise defects as transport errors', async () => {
    const defect = new RangeError('bug');
    const client = new OllamaClient(config, () => Promise.reject(defect));
    await expect(client.generate({ system: 'S', prompt: 'P' })).rejects.toBe(defect);
    await expect(client.loadModel()).rejects.toBe(defect);
    const bodyDefect = new OllamaClient(config, () =>
      Promise.resolve(new Response('{"response": 1}')),
    );
    await expect(bodyDefect.generate({ system: 'S', prompt: 'P' })).rejects.toThrow('non-text');
  });

  it('loads the model with an empty prompt and the same model options as real calls', async () => {
    const ollama = new FakeOllama().reply({ response: 'raw' });
    const { client } = make(ollama);
    await client.loadModel();
    await client.generate({ system: 'S', prompt: 'P' });
    expect(ollama.calls[0]!.body.prompt).toBe('');
    expect(ollama.calls[0]!.body.options).toEqual(ollama.calls[1]!.body.options);
  });
});

describe('OllamaAssistant', () => {
  const request = { message: 'hi there', conversation: [] };

  it('returns a valid plan from one call', async () => {
    const ollama = new FakeOllama().reply(plan({ intent: 'summary', needs: [] }));
    await expect(make(ollama).assistant.plan(request)).resolves.toMatchObject({
      intent: 'summary',
    });
    expect(ollama.promptCalls).toHaveLength(1);
  });

  it('retries once, asking again for the format of the exchange', async () => {
    const ollama = new FakeOllama().reply({ response: 'nope' }, plan({ intent: 'explain' }));
    await expect(make(ollama).assistant.plan(request)).resolves.toMatchObject({
      intent: 'explain',
    });
    expect(ollama.promptCalls[1]!.body.prompt).toContain(
      'rejected because: the reply is not valid JSON',
    );
    expect(ollama.promptCalls[1]!.body.prompt).toContain('one JSON object');
  });

  it('fails with a protocol error after a second invalid reply', async () => {
    const ollama = new FakeOllama().reply({ response: 'nope' }, { response: '{"intent":1}' });
    await expect(make(ollama).assistant.plan(request)).rejects.toThrow(AssistantProtocolError);
    expect(ollama.promptCalls).toHaveLength(2);
  });

  it('does not retry transport errors', async () => {
    const ollama = new FakeOllama().reply({ status: 500 });
    await expect(make(ollama).assistant.plan(request)).rejects.toThrow(AssistantTransportError);
    expect(ollama.promptCalls).toHaveLength(1);
  });

  it('never proposes an edit when the plan is not an edit', async () => {
    const editLike = 'OPERATION: delete\nLINE: 1\nLINE_TEXT: a';
    const ollama = new FakeOllama().reply({ response: editLike });
    const reply = await make(ollama).assistant.reply({
      ...request,
      plan: { intent: 'explain', needs: [], reason: '' },
      evidence: { document: createDocumentSnapshot(['a']) },
    });
    expect(reply).toEqual({ kind: 'answer', text: editLike });
  });

  it('sends a mistyped edit target back to the model with the real line text', async () => {
    const shown = createDocumentSnapshot(['\\section{A}', 'Body text. More.']);
    const ollama = new FakeOllama().reply(
      { response: 'OPERATION: delete\nLINE: 2\nLINE_TEXT: Body text.\nREASON: r\nPLAN: p' },
      { response: 'OPERATION: delete\nLINE: 2\nLINE_TEXT: Body text. More.\nREASON: r\nPLAN: p' },
    );
    const reply = await make(ollama).assistant.reply({
      ...request,
      plan: { intent: 'edit', needs: [], reason: '' },
      evidence: { document: shown },
    });
    expect(reply).toMatchObject({ kind: 'edit', edit: { command: { target: { lineNumber: 2 } } } });
    expect(ollama.promptCalls[1]!.body.prompt).toContain('which reads: Body text. More.');
    expect(ollama.promptCalls[1]!.body.prompt).toContain('No JSON');
  });
});
