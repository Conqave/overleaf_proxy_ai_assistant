import { EMPTY_CONVERSATION } from '../../support/fakes';
import { describe, expect, it } from 'vitest';
import type { ExchangeMessage } from '../../../src/domain/conversation';
import {
  createConversationSummary,
  type ConversationView,
} from '../../../src/domain/conversation-view';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { ProjectFileKind } from '../../../src/domain/project-file';
import { createAgentExchange } from '../../../src/infrastructure/ollama/agent-protocol';
import { planCompaction } from '../../../src/infrastructure/ollama/compaction-planner';
import {
  AUTO_COMPACTION_TOKENS,
  ESTIMATED_PROMPT_CHARS,
  MIN_COMPACTED_TOKENS,
  PRESERVED_RECENT_TOKENS,
  TokenEstimate,
} from '../../../src/infrastructure/ollama/context-budget';
import {
  createSummaryExchange,
  parseSummary,
} from '../../../src/infrastructure/ollama/summary-protocol';
import { InvalidAssistantResponse } from '../../../src/infrastructure/ollama/reply-parser';
import type { AgentStepRequest } from '../../../src/ports/agent-port';
import { TestFixtureError } from '../../support/test-errors';

const CHARS_PER_TOKEN = 2;

function turns(count: number, answerTokens: number): ExchangeMessage[] {
  return Array.from({ length: count }, (_, turn): ExchangeMessage[] => [
    { id: `u${String(turn)}`, role: 'user', text: `question ${String(turn)}` },
    {
      id: `a${String(turn)}`,
      role: 'assistant',
      kind: 'explanation',
      text: 'x'.repeat(answerTokens * CHARS_PER_TOKEN),
    },
  ]).flat();
}

function step(conversation: ConversationView): AgentStepRequest {
  return {
    request: { kind: 'user', message: { id: 'r', role: 'user', text: 'next' } },
    conversation,
    workspace: {
      files: [{ id: '1', path: 'main.tex', kind: ProjectFileKind.Text }],
      openFile: { path: 'main.tex', document: createDocumentSnapshot(['\\section{A}']) },
      cursorLine: 1,
      selection: '',
    },
    transcript: [],
    signal: new AbortController().signal,
  };
}

const keptTokens = (messages: readonly ExchangeMessage[], covered: number): number =>
  messages
    .slice(covered)
    .reduce((total, message) => total + JSON.stringify(message).length / CHARS_PER_TOKEN, 0);

describe('planCompaction before a model call', () => {
  it('leaves a conversation alone while the prompt is below the threshold', () => {
    const conversation = { summary: null, messages: turns(10, 1_000) };
    expect(planCompaction({ kind: 'auto', step: step(conversation) }, new TokenEstimate())).toBe(
      null,
    );
  });

  it('summarises all but the most recent turns once the prompt nears the window', () => {
    const messages = turns(40, 2_000);
    const plan = planCompaction(
      { kind: 'auto', step: step({ summary: null, messages }) },
      new TokenEstimate(),
    );
    if (plan === null) throw new TestFixtureError('nothing was planned');
    const covered = plan.covered.length;
    expect(plan.covered).toEqual(messages.slice(0, covered));
    expect(messages[covered]).toMatchObject({ role: 'user' });
    expect(keptTokens(messages, covered)).toBeLessThan(PRESERVED_RECENT_TOKENS + 2_100);
    expect(keptTokens(messages, covered)).toBeGreaterThan(PRESERVED_RECENT_TOKENS - 2_100);
  });

  it('trips at the threshold of the calibrated estimate', () => {
    const messages = turns(30, 2_000);
    const conversation = { summary: null, messages };
    const plain = new TokenEstimate();
    expect(planCompaction({ kind: 'auto', step: step(conversation) }, plain)).toBeNull();
    const dense = new TokenEstimate();
    dense.calibrate(1_000, 1_000);
    expect(planCompaction({ kind: 'auto', step: step(conversation) }, dense)).not.toBeNull();
    expect(AUTO_COMPACTION_TOKENS).toBeGreaterThan(60_000);
  });
});

describe('planCompaction on demand', () => {
  it('keeps about half of the conversation and the latest turn', () => {
    const messages = turns(10, 1_000);
    const plan = planCompaction(
      { kind: 'manual', conversation: { summary: null, messages } },
      new TokenEstimate(),
    );
    expect(plan?.covered.map(({ id }) => id)).toEqual([
      'u0',
      'a0',
      'u1',
      'a1',
      'u2',
      'a2',
      'u3',
      'a3',
      'u4',
      'a4',
    ]);
  });

  it('never summarises the latest turn, however large', () => {
    const messages = [
      ...turns(2, 1_500),
      ...turns(1, 50_000).map((m) => ({ ...m, id: `big-${m.id}` })),
    ];
    const plan = planCompaction(
      { kind: 'manual', conversation: { summary: null, messages } },
      new TokenEstimate(),
    );
    expect(plan?.covered.map(({ id }) => id)).toEqual(['u0', 'a0', 'u1', 'a1']);
  });

  it('leaves earlier turns too small for a summary to shrink', () => {
    const conversation = { summary: null, messages: turns(4, 400) };
    expect(planCompaction({ kind: 'manual', conversation }, new TokenEstimate())).toBeNull();
    expect(MIN_COMPACTED_TOKENS).toBe(2_000);
  });

  it('has nothing to compact in a single turn or an empty conversation', () => {
    const estimate = new TokenEstimate();
    const single = { summary: null, messages: turns(1, 5_000) };
    expect(planCompaction({ kind: 'manual', conversation: single }, estimate)).toBeNull();
    expect(
      planCompaction({ kind: 'manual', conversation: EMPTY_CONVERSATION }, estimate),
    ).toBeNull();
  });
});

describe('TokenEstimate', () => {
  it('counts two characters per token until the model counts more', () => {
    const estimate = new TokenEstimate();
    expect(estimate.tokensOf(2_000)).toBe(1_000);
    estimate.calibrate(2_000, 500);
    expect(estimate.tokensOf(2_000)).toBe(1_000);
    estimate.calibrate(2_000, 2_000);
    expect(estimate.tokensOf(2_000)).toBe(2_000);
    estimate.calibrate(100, 10_000);
    expect(estimate.tokensOf(100)).toBe(200);
  });
});

describe('summary exchange', () => {
  const covered: ExchangeMessage[] = [
    { id: 'u1', role: 'user', text: 'Zapamiętaj: skrót projektu to HX-42.' },
    { id: 'a1', role: 'assistant', kind: 'explanation', text: 'Zapamiętane.' },
  ];

  it('asks for the continuation note of the covered turns with the previous summary', () => {
    const previous = createConversationSummary(null, '## Goal\nA report.', [
      {
        id: 't',
        role: 'tool',
        record: {
          tool: 'read_file',
          path: 'refs.bib',
          shown: { first: 1, last: 1 },
          totalLines: 1,
          lines: ['@book{a,}'],
        },
      },
    ]);
    const { request } = createSummaryExchange(
      { previous, covered, signal: new AbortController().signal },
      ESTIMATED_PROMPT_CHARS,
    );
    for (const section of [
      '## Goal',
      '## State',
      '## Highlights',
      '## Next',
      '## User preferences',
    ]) {
      expect(request.system).toContain(section);
    }
    expect(request.prompt).toContain(
      'Previous summary, to be updated with the conversation below:\n[summary of the 0 earlier turns]\n## Goal\nA report.\nFiles read: refs.bib\nFiles edited: none',
    );
    expect(request.prompt).toContain(
      'Conversation to summarise:\n[user] Zapamiętaj: skrót projektu to HX-42.\n[assistant] Zapamiętane.',
    );
  });

  it('shortens a conversation too long for one prompt', () => {
    const long: ExchangeMessage[] = [
      { id: 'u', role: 'user', text: 'y'.repeat(ESTIMATED_PROMPT_CHARS) },
    ];
    const { request } = createSummaryExchange(
      { previous: null, covered: long, signal: new AbortController().signal },
      ESTIMATED_PROMPT_CHARS,
    );
    expect(request.system.length + request.prompt.length).toBeLessThan(ESTIMATED_PROMPT_CHARS);
    expect(request.prompt).toContain('[AUTOCOMPACTED: omitted');
  });

  it('accepts a note and rejects an empty reply or an action', () => {
    expect(parseSummary('\n## Goal\nA report.\n')).toBe('## Goal\nA report.');
    expect(() => parseSummary('  ')).toThrow(InvalidAssistantResponse);
    expect(() => parseSummary('ACTION: answer\nTEXT:\nx')).toThrow(InvalidAssistantResponse);
  });
});

describe('summary in the agent prompt', () => {
  it('stands in for the turns it covers, with the files it lists', () => {
    const summary = createConversationSummary(null, '## Goal\nTidy the report.', [
      { id: 'u0', role: 'user', text: 'old question' },
      {
        id: 'p0',
        role: 'assistant',
        kind: 'proposal',
        path: 'main.tex',
        command: { operation: 'delete', target: { lineNumber: 1, lineText: 'x' }, lineCount: 1 },
        status: 'applied',
      },
    ]);
    const { prompt } = createAgentExchange(
      step({ summary, messages: [{ id: 'u1', role: 'user', text: 'recent question' }] }),
      ESTIMATED_PROMPT_CHARS,
    ).request;
    expect(prompt).toContain(
      'Conversation so far:\n[summary of the 1 earlier turns]\n## Goal\nTidy the report.\nFiles read: none\nFiles edited: main.tex\n[user] recent question',
    );
    expect(prompt).not.toContain('old question');
  });
});
