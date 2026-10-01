import { describe, expect, it, vi } from 'vitest';
import { OllamaAgent } from '../../../src/infrastructure/ollama/ollama-agent';
import { OllamaClient } from '../../../src/infrastructure/ollama/ollama-client';
import {
  getPromptBudget,
  MIN_CONTEXT_TOKENS,
} from '../../../src/infrastructure/ollama/prompt-blocks';
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
import { ProjectFileKind } from '../../../src/domain/project-file';
import type { AgentStepRequest } from '../../../src/ports/agent-port';

const config = {
  endpoint: '/ollama/main/api/generate',
  model: 'm',
  contextTokens: MIN_CONTEXT_TOKENS,
  timeoutMs: 50,
};
const make = (ollama: FakeOllama) => ({ client: new OllamaClient(config, ollama.fetch) });

describe('OllamaClient', () => {
  it('posts the request in the harmony format of the model and returns its final message', async () => {
    const ollama = new FakeOllama().reply({ response: 'raw' });
    await expect(make(ollama).client.generate({ system: 'S', prompt: 'P' })).resolves.toMatchObject(
      {
        text: 'raw',
      },
    );
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
      options: { num_ctx: MIN_CONTEXT_TOKENS, num_predict: 4_096, temperature: 0.2 },
    });
  });

  it('returns the final message that follows the analysis', async () => {
    const ollama = new FakeOllama().reply({
      completion:
        '<|channel|>analysis<|message|>Think.<|end|><|start|>assistant<|channel|>final<|message|>Done.',
    });
    await expect(make(ollama).client.generate({ system: 'S', prompt: 'P' })).resolves.toMatchObject(
      {
        text: 'Done.',
      },
    );
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
    const completion = await make(ollama).client.generate({ system: 'S', prompt: 'P' });
    const [first, second] = ollama.promptCalls;
    expect(completion).toEqual({
      text: 'ACTION: read_file',
      promptTokens: second!.harmonyPrompt.length,
    });
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

  it.each([
    ['no token count', '{"response": "r"}', 'Ollama returned no "prompt_eval_count" field.'],
    [
      'a token count that is not a count',
      '{"response": "r", "prompt_eval_count": -1}',
      'Ollama returned a "prompt_eval_count" that is not a token count.',
    ],
  ])('reports a body with %s as a broken response contract', async (_name, body, message) => {
    const client = new OllamaClient(config, () => Promise.resolve(new Response(body)));
    await expect(client.generate({ system: 'S', prompt: 'P' })).rejects.toThrow(
      new AssistantResponseContractError(message),
    );
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

describe('OllamaAgent', () => {
  const step: AgentStepRequest = {
    message: 'Which title does the cited work have?',
    conversation: [],
    workspace: {
      files: [
        { id: '1', path: 'main.tex', kind: ProjectFileKind.Text },
        { id: '2', path: 'refs.bib', kind: ProjectFileKind.Text },
      ],
      openFile: { path: 'main.tex', document: createDocumentSnapshot(['\\cite{a}']) },
      cursorLine: 1,
      selection: '',
    },
    transcript: [],
  };
  const agent = (ollama: FakeOllama) => new OllamaAgent(make(ollama).client);

  it('decides on a tool call from one model call', async () => {
    const ollama = new FakeOllama().reply({ response: 'ACTION: read_file\nPATH: refs.bib' });
    const { decision } = await agent(ollama).decide(step);
    expect(decision).toEqual({ kind: 'tool', call: { tool: 'read_file', path: 'refs.bib' } });
    expect(ollama.promptCalls).toHaveLength(1);
  });

  it('reports the context window, the estimated and the counted size of its prompt', async () => {
    const ollama = new FakeOllama().reply({ response: 'ACTION: compile' });
    const { contextUsage } = await agent(ollama).decide(step);
    const [call] = ollama.promptCalls;
    const sent = call!.body.system!.length + call!.body.prompt.length;
    expect(contextUsage).toEqual({
      contextTokens: MIN_CONTEXT_TOKENS,
      estimatedPromptTokens: Math.ceil(sent / 3),
      promptTokens: call!.harmonyPrompt.length,
    });
  });

  it('sends an invalid action back to the model once', async () => {
    const ollama = new FakeOllama().reply(
      { response: 'ACTION: read_file\nPATH: missing.tex' },
      { response: 'ACTION: answer\nTEXT:\nThe file is not in the project.' },
    );
    const { decision, contextUsage } = await agent(ollama).decide(step);
    expect(decision).toEqual({
      kind: 'reply',
      reply: { kind: 'answer', text: 'The file is not in the project.' },
    });
    expect(contextUsage.promptTokens).toBe(ollama.promptCalls[1]!.harmonyPrompt.length);
    expect(ollama.promptCalls[1]!.body.prompt).toContain('missing.tex');
    expect(ollama.promptCalls[1]!.body.prompt).toContain('Reply again with exactly one action');
  });

  it('fails with a protocol error after a second invalid reply', async () => {
    const ollama = new FakeOllama().reply({ response: 'hello' }, { response: 'ACTION: dance' });
    await expect(agent(ollama).decide(step)).rejects.toThrow(AssistantProtocolError);
  });

  it('does not retry transport errors', async () => {
    const ollama = new FakeOllama().reply({ status: 500 });
    await expect(agent(ollama).decide(step)).rejects.toThrow(AssistantHttpError);
    expect(ollama.promptCalls).toHaveLength(1);
  });

  it('sizes its prompts to the context window of its client', async () => {
    const long = { ...step, message: 'm'.repeat(getPromptBudget(MIN_CONTEXT_TOKENS)) };
    await expect(agent(new FakeOllama()).decide(long)).rejects.toThrow(
      AssistantRequestTooLargeError,
    );
    const ollama = new FakeOllama().reply({ response: 'ACTION: compile' });
    const wide = new OllamaClient(
      { ...config, contextTokens: 2 * MIN_CONTEXT_TOKENS },
      ollama.fetch,
    );
    await expect(new OllamaAgent(wide).decide(long)).resolves.toMatchObject({
      decision: { kind: 'tool', call: { tool: 'compile' } },
    });
  });

  it('sends a mistyped edit target back to the model with the real line text', async () => {
    const edit = (lineText: string) => ({
      response: `ACTION: edit\nPATH: main.tex\nOPERATION: delete\nLINE: 2\nLINE_TEXT: ${lineText}`,
    });
    const shown = {
      path: 'main.tex',
      document: createDocumentSnapshot(['\\cite{a}', 'Body text. More.']),
    };
    const ollama = new FakeOllama().reply(edit('Body text.'), edit('Body text. More.'));
    const { decision } = await agent(ollama).decide({
      ...step,
      workspace: { ...step.workspace, openFile: shown },
    });
    expect(decision).toMatchObject({
      reply: { change: { edit: { command: { target: { lineNumber: 2 } } } } },
    });
    const [, correction] = ollama.promptCalls;
    expect(correction?.body.prompt).toContain('which reads: Body text. More.');
    expect(correction?.body.prompt).toContain('No JSON');
  });
});
