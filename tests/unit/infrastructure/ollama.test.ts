import { describe, expect, it, vi } from 'vitest';
import { OllamaAssistant } from '../../../src/infrastructure/ollama/ollama-assistant';
import { OllamaClient } from '../../../src/infrastructure/ollama/ollama-client';
import {
  getPromptBudget,
  MIN_CONTEXT_TOKENS,
} from '../../../src/infrastructure/ollama/assistant-protocol';
import { preloadOllamaModel } from '../../../src/infrastructure/ollama/ollama-preload';
import {
  AssistantHttpError,
  AssistantProtocolError,
  AssistantRequestTooLargeError,
  AssistantResponseContractError,
  AssistantTimeoutError,
  AssistantUnreachableError,
} from '../../../src/ports/errors';
import { FakeOllama } from '../../support/fake-ollama';
import { createDocumentSnapshot } from '../../../src/domain/document';

const config = {
  endpoint: '/ollama/main/api/generate',
  model: 'm',
  contextTokens: MIN_CONTEXT_TOKENS,
  timeoutMs: 50,
};
const make = (ollama: FakeOllama) => {
  const client = new OllamaClient(config, ollama.fetch);
  return { client, assistant: new OllamaAssistant(client) };
};
const plan = (value: unknown) => ({ response: JSON.stringify(value) });

describe('OllamaClient', () => {
  it('posts the request in the harmony format of the model and returns its final message', async () => {
    const ollama = new FakeOllama().reply({ response: 'raw' });
    await expect(make(ollama).client.generate({ system: 'S', prompt: 'P' })).resolves.toBe('raw');
    const [call] = ollama.calls;
    expect(call!.url).toBe('/ollama/main/api/generate');
    expect(call!.harmonyPrompt).toMatch(
      /^<\|start\|>system<\|message\|>[^]*Reasoning: medium[^]*<\|end\|><\|start\|>developer<\|message\|># Instructions\n\nS<\|end\|><\|start\|>user<\|message\|>P<\|end\|><\|start\|>assistant$/,
    );
    expect(call!.body).toEqual({
      model: 'm',
      stream: false,
      keep_alive: -1,
      raw: true,
      system: 'S',
      prompt: 'P',
      options: { num_ctx: MIN_CONTEXT_TOKENS, temperature: 0.2 },
    });
  });

  it('returns the final message that follows the analysis', async () => {
    const ollama = new FakeOllama().reply({
      completion:
        '<|channel|>analysis<|message|>Think.<|end|><|start|>assistant<|channel|>final<|message|>Done.',
    });
    await expect(make(ollama).client.generate({ system: 'S', prompt: 'P' })).resolves.toBe('Done.');
    expect(ollama.promptCalls).toHaveLength(1);
  });

  it('asks for the final message, keeping the analysis, when the model addresses a function', async () => {
    const ollama = new FakeOllama().reply(
      {
        completion:
          '<|channel|>analysis<|message|>Read it.<|end|><|start|>assistant<|channel|>commentary to=assistant<|message|>{"PATH":"a.tex"}',
      },
      { completion: 'ACTION: read_file' },
    );
    await expect(make(ollama).client.generate({ system: 'S', prompt: 'P' })).resolves.toBe(
      'ACTION: read_file',
    );
    const [first, second] = ollama.promptCalls;
    expect(second!.harmonyPrompt).toBe(
      `${first!.harmonyPrompt}<|channel|>analysis<|message|>Read it.<|end|><|start|>assistant<|channel|>final<|message|>`,
    );
  });

  it('asks for the final message without an analysis when the model skipped it', async () => {
    const ollama = new FakeOllama().reply(
      { completion: '<|channel|>commentary to=functions.read<|message|>{}' },
      { completion: 'ACTION: compile' },
    );
    await make(ollama).client.generate({ system: 'S', prompt: 'P' });
    expect(ollama.promptCalls[1]!.harmonyPrompt).toContain(
      '<|start|>assistant<|channel|>analysis<|message|><|end|><|start|>assistant<|channel|>final<|message|>',
    );
  });

  it('reports HTTP errors with their status', async () => {
    const ollama = new FakeOllama().reply({ status: 502 });
    await expect(make(ollama).client.generate({ system: 'S', prompt: 'P' })).rejects.toMatchObject({
      name: AssistantHttpError.name,
      status: 502,
    });
  });

  it('reports a body that is not JSON as a broken response contract', async () => {
    const client = new OllamaClient(config, () => Promise.resolve(new Response('<html>')));
    await expect(client.generate({ system: 'S', prompt: 'P' })).rejects.toThrow(
      new AssistantResponseContractError('Ollama sent a body that is not JSON.'),
    );
  });

  it('reports network failures as an unreachable Ollama', async () => {
    const client = new OllamaClient(config, () => Promise.reject(new TypeError('offline')));
    await expect(client.generate({ system: 'S', prompt: 'P' })).rejects.toThrow(
      AssistantUnreachableError,
    );
    await expect(client.loadModel()).rejects.toThrow(AssistantUnreachableError);
  });

  it('reports a body without a response as a broken response contract', async () => {
    const client = new OllamaClient(config, () => Promise.resolve(new Response('{"done":true}')));
    await expect(client.generate({ system: 'S', prompt: 'P' })).rejects.toThrow(
      new AssistantResponseContractError('Ollama returned no "response" field.'),
    );
  });

  it('times out, naming the configured limit', async () => {
    const ollama = new FakeOllama().reply({ hang: true });
    await expect(make(ollama).client.generate({ system: 'S', prompt: 'P' })).rejects.toThrow(
      new AssistantTimeoutError('Ollama did not respond within 50 milliseconds.'),
    );
  });

  it.each([
    [1_000, '1 second'],
    [1_500, '1,500 milliseconds'],
    [90_000, '90 seconds'],
    [60_000, '1 minute'],
    [300_000, '5 minutes'],
  ])('writes a limit of %i ms as %s', async (timeoutMs, duration) => {
    const hanging = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    vi.useFakeTimers();
    try {
      const client = new OllamaClient({ ...config, timeoutMs }, hanging);
      const assertion = expect(client.generate({ system: 'S', prompt: 'P' })).rejects.toThrow(
        `within ${duration}.`,
      );
      await vi.advanceTimersByTimeAsync(timeoutMs);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not disguise defects as transport errors', async () => {
    const defect = new RangeError('bug');
    const client = new OllamaClient(config, () => Promise.reject(defect));
    await expect(client.generate({ system: 'S', prompt: 'P' })).rejects.toBe(defect);
    await expect(client.loadModel()).rejects.toBe(defect);
    const bodyDefect = new OllamaClient(config, () =>
      Promise.resolve(new Response('{"response": 1}')),
    );
    await expect(bodyDefect.generate({ system: 'S', prompt: 'P' })).rejects.toThrow(
      AssistantResponseContractError,
    );
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

describe('preloadOllamaModel', () => {
  it('gives up quietly when Ollama is unreachable', async () => {
    const client = new OllamaClient(config, () => Promise.reject(new TypeError('offline')));
    await expect(preloadOllamaModel(client)).resolves.toBeUndefined();
  });

  it('lets an HTTP error of the model load through', async () => {
    const client = new OllamaClient(config, () =>
      Promise.resolve(new Response('error', { status: 500 })),
    );
    await expect(preloadOllamaModel(client)).rejects.toThrow(AssistantHttpError);
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

  it('sizes its prompts to the context window of its client', async () => {
    const long = { message: 'm'.repeat(getPromptBudget(MIN_CONTEXT_TOKENS)), conversation: [] };
    await expect(make(new FakeOllama()).assistant.plan(long)).rejects.toThrow(
      AssistantRequestTooLargeError,
    );
    const ollama = new FakeOllama().reply(plan({ intent: 'summary' }));
    const wide = new OllamaClient(
      { ...config, contextTokens: 2 * MIN_CONTEXT_TOKENS },
      ollama.fetch,
    );
    await expect(new OllamaAssistant(wide).plan(long)).resolves.toMatchObject({
      intent: 'summary',
    });
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
    await expect(make(ollama).assistant.plan(request)).rejects.toThrow(AssistantHttpError);
    expect(ollama.promptCalls).toHaveLength(1);
  });

  it('never proposes an edit when the plan is not an edit', async () => {
    const editLike = 'OPERATION: delete\nLINE: 1\nLINE_TEXT: a';
    const ollama = new FakeOllama().reply({ response: editLike });
    const reply = await make(ollama).assistant.reply({
      ...request,
      plan: { intent: 'explain', needs: [] },
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
      plan: { intent: 'edit', needs: [] },
      evidence: { document: shown },
    });
    expect(reply).toMatchObject({ kind: 'edit', edit: { command: { target: { lineNumber: 2 } } } });
    expect(ollama.promptCalls[1]!.body.prompt).toContain('which reads: Body text. More.');
    expect(ollama.promptCalls[1]!.body.prompt).toContain('No JSON');
  });
});
