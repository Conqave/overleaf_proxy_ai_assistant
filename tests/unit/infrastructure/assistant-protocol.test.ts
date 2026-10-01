import { describe, expect, it } from 'vitest';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { ProjectFileKind } from '../../../src/domain/project-file';
import { createAgentExchange } from '../../../src/infrastructure/ollama/agent-protocol';
import {
  createCorrectionRequest,
  getPromptBudget,
  MIN_CONTEXT_TOKENS,
} from '../../../src/infrastructure/ollama/assistant-protocol';
import type { AgentStepRequest } from '../../../src/ports/agent-port';
import { TestFixtureError } from '../../support/test-errors';

const budget = getPromptBudget(MIN_CONTEXT_TOKENS);
const conversation = Array.from({ length: 15 }, (_, i) => ({
  id: String(i),
  role: 'user' as const,
  text: `message ${String(i)}`,
}));

const request = (overrides: Partial<AgentStepRequest> = {}): AgentStepRequest => ({
  message: 'm',
  conversation: [],
  workspace: {
    files: [{ id: '1', path: 'main.tex', kind: ProjectFileKind.Text }],
    openFile: { path: 'main.tex', document: createDocumentSnapshot(['\\section{A}', 'Body.']) },
    cursorLine: 1,
    selection: '',
  },
  transcript: [],
  ...overrides,
});

const promptOf = (overrides: Partial<AgentStepRequest>): string =>
  createAgentExchange(request(overrides), budget).request.prompt;

const withSelection = (selection: string): Partial<AgentStepRequest> => ({
  workspace: { ...request().workspace, selection },
});

describe('conversation history', () => {
  it('carries the message and the last 12 turns', () => {
    const prompt = promptOf({ message: 'Add a table', conversation });
    expect(prompt).toContain('User message:\nAdd a table');
    expect(prompt).toContain('[user] message 14');
    expect(prompt).toContain('[user] message 3');
    expect(prompt).not.toContain('[user] message 2\n');
  });

  it('leaves out the greetings answered without the model', () => {
    const prompt = promptOf({
      conversation: [
        { id: 'u', role: 'user', text: 'hi' },
        { id: 'g', role: 'assistant', kind: 'greeting' },
      ],
    });
    expect(prompt).toContain('Conversation so far:\n[user] hi');
    expect(prompt).not.toContain('[assistant]');
  });

  it('shows a proposal to the model as its operation, reason and content', () => {
    const proposal = {
      id: 'p',
      role: 'assistant' as const,
      kind: 'proposal' as const,
      path: 'main.tex',
      command: createDocumentCommand({
        operation: 'replace',
        target: { lineNumber: 2, lineText: 'Body.' },
        content: 'New body.',
        reason: 'Clearer.',
      }),
      rationale: 'p',
    };
    expect(promptOf({ conversation: [proposal] })).toContain(
      '[assistant] Proposed replace at line 2: Clearer.\nNew body.',
    );
  });
});

describe('correction request', () => {
  it('keeps the instructions, names the problem and caps the rejected reply', () => {
    const exchange = createAgentExchange(request(), budget);
    const correction = createCorrectionRequest(exchange, 'bad', 'the reply is JSON');
    expect(correction.system).toBe(exchange.request.system);
    expect(correction.prompt.startsWith(exchange.request.prompt)).toBe(true);
    expect(correction.prompt).toContain('Your previous reply was:\nbad');
    expect(correction.prompt).toContain('It was rejected because: the reply is JSON.');
    const long = createCorrectionRequest(exchange, 'z'.repeat(100_000), 'x');
    expect(long.prompt.length - exchange.request.prompt.length).toBeLessThan(4_096);
  });
});

describe('compaction', () => {
  it('keeps the head and the tail of a long block and says how much it left out', () => {
    const selection = 'a'.repeat(50_000) + 'b'.repeat(50_000);
    const compacted =
      /Selected text:\n(a+)\n\n\[AUTOCOMPACTED: omitted (\d+) chars\]\n\n(b+)\n/.exec(
        promptOf(withSelection(selection)),
      );
    if (compacted === null) throw new TestFixtureError('the selection was not compacted');
    const [, head = '', omitted, tail = ''] = compacted;
    expect(head.length).toBe(tail.length);
    expect(head.length + Number(omitted) + tail.length).toBe(selection.length);
  });

  it('leaves a block that fits untouched', () => {
    const prompt = promptOf(withSelection('short'));
    expect(prompt).toContain('Selected text:\nshort');
    expect(prompt).not.toContain('AUTOCOMPACTED');
  });
});
