import { describe, expect, it } from 'vitest';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { InvariantViolation } from '../../../src/domain/errors';
import { AssistantRequestTooLargeError } from '../../../src/ports/errors';
import {
  compact,
  createCorrectionRequest,
  createPlanExchange,
  createReplyExchange,
  getPromptBudget,
  MIN_CONTEXT_TOKENS,
} from '../../../src/infrastructure/ollama/assistant-protocol';
import type { ReplyRequest } from '../../../src/ports/assistant-port';

const document = createDocumentSnapshot(['\\section{A}', 'Body.']);
const budget = getPromptBudget(MIN_CONTEXT_TOKENS);
const conversation = Array.from({ length: 15 }, (_, i) => ({
  id: String(i),
  role: 'user' as const,
  text: `message ${String(i)}`,
}));

const reply = (overrides: Partial<ReplyRequest> = {}): ReplyRequest => ({
  message: 'm',
  plan: { intent: 'explain', needs: [] },
  evidence: { document },
  conversation: [],
  ...overrides,
});

describe('plan exchange', () => {
  it('carries the schema, the message and the last 12 turns, and parses a JSON plan', () => {
    const exchange = createPlanExchange({ message: 'Add a table', conversation }, budget);
    expect(exchange.request.system).toContain('"intent":"summary|explain|edit"');
    expect(exchange.request.prompt).toContain('User message:\nAdd a table');
    expect(exchange.request.prompt).toContain('[user] message 14');
    expect(exchange.request.prompt).toContain('[user] message 3');
    expect(exchange.request.prompt).not.toContain('[user] message 2\n');
    expect(exchange.parse('{"intent":"summary"}')).toMatchObject({ intent: 'summary' });
  });
});

describe('conversation history', () => {
  it('leaves out the greetings answered without the model', () => {
    const exchange = createPlanExchange(
      {
        message: 'm',
        conversation: [
          { id: 'u', role: 'user', text: 'hi' },
          { id: 'g', role: 'assistant', kind: 'greeting' },
        ],
      },
      budget,
    );
    expect(exchange.request.prompt).toContain('Conversation so far:\n[user] hi');
    expect(exchange.request.prompt).not.toContain('[assistant]');
  });

  it('shows a proposal to the model as its operation, reason and content', () => {
    const proposal = {
      id: 'p',
      role: 'assistant' as const,
      kind: 'proposal' as const,
      command: createDocumentCommand({
        operation: 'replace',
        target: { lineNumber: 2, lineText: 'Body.' },
        content: 'New body.',
        reason: 'Clearer.',
      }),
      rationale: 'p',
    };
    const exchange = createPlanExchange({ message: 'm', conversation: [proposal] }, budget);
    expect(exchange.request.prompt).toContain(
      '[assistant] Proposed replace at line 2: Clearer.\nNew body.',
    );
  });
});

describe('reply exchange', () => {
  it('gives an answer the plain document and parses plain text', () => {
    const exchange = createReplyExchange(reply(), budget);
    expect(exchange.request.prompt).toContain('Document text:\n\\section{A}\nBody.');
    expect(exchange.request.prompt).not.toContain('Numbered document lines');
    expect(exchange.request.system).not.toContain('OPERATION:');
    expect(exchange.parse(' Because. ')).toEqual({ kind: 'answer', text: 'Because.' });
  });

  it('gives an edit the numbered document and the gathered evidence', () => {
    const exchange = createReplyExchange(
      reply({
        plan: { intent: 'edit', needs: [], reason: 'r' },
        evidence: {
          document,
          lineContext: { firstLineNumber: 2, lines: ['Body.'] },
          selection: 'Bo',
          logs: 'warning',
        },
      }),
      budget,
    );
    expect(exchange.request.system).toContain(
      'OPERATION: insert_before|insert_after|replace|delete',
    );
    expect(exchange.request.prompt).toContain(
      'Numbered document lines:\n1: \\section{A}\n2: Body.',
    );
    expect(exchange.request.prompt).not.toContain('Document text:');
    expect(exchange.request.prompt).toContain('Lines around the caret:\n2: Body.');
    expect(exchange.request.prompt).toContain('Selected text:\nBo');
    expect(exchange.request.prompt).toContain('Compile logs:\nwarning');
    expect(exchange.request.prompt).toContain('Planner reason:\nr');
  });

  it('parses an edit against the document the model was shown', () => {
    const exchange = createReplyExchange(reply({ plan: { intent: 'edit', needs: [] } }), budget);
    const edit = exchange.parse('OPERATION: delete\nLINE: 2\nLINE_TEXT: Body.\nREASON: r\nPLAN: p');
    expect(edit).toMatchObject({ kind: 'edit', edit: { document } });
  });

  it('keeps the whole prompt within the budget, shortening the document first', () => {
    const long = createDocumentSnapshot(Array.from({ length: 20_000 }, () => 'x'.repeat(40)));
    const exchange = createReplyExchange(
      reply({ evidence: { document: long, logs: 'l'.repeat(50_000) }, conversation }),
      budget,
    );
    const size = exchange.request.system.length + exchange.request.prompt.length;
    expect(size).toBeLessThanOrEqual(budget);
    expect(exchange.request.prompt).toContain('AUTOCOMPACTED');
  });
});

describe('prompt budget', () => {
  it('fits a long planner reason and long caret lines into the budget', () => {
    const exchange = createReplyExchange(
      reply({
        plan: { intent: 'edit', needs: [], reason: 'r'.repeat(50_000) },
        evidence: {
          document,
          lineContext: { firstLineNumber: 1, lines: ['c'.repeat(50_000)] },
        },
      }),
      budget,
    );
    expect(exchange.request.system.length + exchange.request.prompt.length).toBeLessThanOrEqual(
      budget,
    );
  });

  it('refuses a message too long for the context window', () => {
    const huge = { message: 'm'.repeat(budget) };
    expect(() => createReplyExchange(reply(huge), budget)).toThrow(AssistantRequestTooLargeError);
    expect(() => createPlanExchange({ ...huge, conversation: [] }, budget)).toThrow(
      AssistantRequestTooLargeError,
    );
  });

  it('treats compacting into less than the marker as a defect', () => {
    expect(() => compact('x'.repeat(100), 10)).toThrow(InvariantViolation);
  });
});

describe('correction request', () => {
  it('keeps the instructions, names the problem and asks for the format of its exchange', () => {
    const plan = createPlanExchange({ message: 'm', conversation: [] }, budget);
    const edit = createReplyExchange(reply({ plan: { intent: 'edit', needs: [] } }), budget);
    const answer = createReplyExchange(reply(), budget);
    const correction = createCorrectionRequest(edit, 'bad', 'the reply is JSON');
    expect(correction.system).toBe(edit.request.system);
    expect(correction.prompt.startsWith(edit.request.prompt)).toBe(true);
    expect(correction.prompt).toContain('It was rejected because: the reply is JSON.');
    expect(correction.prompt).toContain('No JSON');
    expect(createCorrectionRequest(plan, 'bad', 'x').prompt).toContain('one JSON object');
    expect(createCorrectionRequest(answer, '', 'x').prompt).toContain('plain text');
    const long = createCorrectionRequest(answer, 'z'.repeat(100_000), 'x');
    expect(long.prompt.length - answer.request.prompt.length).toBeLessThan(4_096);
  });
});

describe('compact', () => {
  it('keeps the head and the tail of a long text', () => {
    const text = 'a'.repeat(100) + 'b'.repeat(100);
    const result = compact(text, 128);
    expect(result.startsWith('a'.repeat(32))).toBe(true);
    expect(result.endsWith('b'.repeat(32))).toBe(true);
    expect(result).toContain('omitted 136 chars');
    expect(compact('short', 128)).toBe('short');
  });
});
