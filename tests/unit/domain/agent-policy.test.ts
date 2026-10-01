import { describe, expect, it } from 'vitest';
import {
  AGENT_POLICY,
  checkToolCall,
  countToolCallsLeft,
  hasMistakesLeft,
} from '../../../src/domain/agent-policy';
import type { AgentTurn } from '../../../src/domain/agent-transcript';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { RepeatedToolCallError, ToolBudgetExhaustedError } from '../../../src/domain/errors';

function readTurn(path: string): AgentTurn {
  return {
    kind: 'tool',
    call: { tool: 'read_file', path },
    result: { tool: 'read_file', path, document: createDocumentSnapshot(['x']) },
  };
}

function mistakeTurn(path: string): AgentTurn {
  return {
    kind: 'mistake',
    decision: { kind: 'tool', call: { tool: 'read_file', path } },
    problem: `The project has no file ${path}.`,
  };
}

const compileTurn: AgentTurn = {
  kind: 'tool',
  call: { tool: 'compile' },
  result: { tool: 'compile', diagnostics: [] },
};

const repeat = <T>(count: number, create: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => create(index));

describe('agent tool policy', () => {
  it('allows a new call within the budget', () => {
    expect(countToolCallsLeft([])).toBe(AGENT_POLICY.maxToolCalls);
    expect(() => {
      checkToolCall([readTurn('a.tex')], { tool: 'read_file', path: 'b.tex' });
    }).not.toThrow();
  });

  it('stops tool calls once the budget is used', () => {
    const full = repeat(AGENT_POLICY.maxToolCalls, (i) => readTurn(`f${String(i)}.tex`));
    expect(countToolCallsLeft(full)).toBe(0);
    expect(() => {
      checkToolCall(full, { tool: 'search', query: 'abc' });
    }).toThrow(ToolBudgetExhaustedError);
  });

  it('does not charge rejected steps to the tool budget', () => {
    expect(countToolCallsLeft([mistakeTurn('a.tex'), readTurn('b.tex')])).toBe(
      AGENT_POLICY.maxToolCalls - 1,
    );
  });

  it('rejects repeating a call', () => {
    expect(() => {
      checkToolCall([readTurn('a.tex')], { tool: 'read_file', path: 'a.tex' });
    }).toThrow(RepeatedToolCallError);
  });

  it('lets a call that was rejected before be made again', () => {
    expect(() => {
      checkToolCall([mistakeTurn('a.tex')], { tool: 'read_file', path: 'a.tex' });
    }).not.toThrow();
  });

  it('allows one compilation per request', () => {
    expect(() => {
      checkToolCall([compileTurn], { tool: 'compile' });
    }).toThrow(RepeatedToolCallError);
  });
});

describe('agent mistake policy', () => {
  const limit = AGENT_POLICY.maxConsecutiveMistakes;

  it('allows fewer consecutive mistakes than the limit', () => {
    expect(hasMistakesLeft([])).toBe(true);
    expect(hasMistakesLeft(repeat(limit - 1, (i) => mistakeTurn(`m${String(i)}`)))).toBe(true);
  });

  it('stops at the limit of consecutive mistakes', () => {
    expect(hasMistakesLeft(repeat(limit, (i) => mistakeTurn(`m${String(i)}`)))).toBe(false);
  });

  it('counts only the mistakes after the last tool call', () => {
    const earlier = repeat(limit - 1, (i) => mistakeTurn(`e${String(i)}`));
    const later = repeat(limit - 1, (i) => mistakeTurn(`l${String(i)}`));
    expect(hasMistakesLeft([...earlier, readTurn('a.tex'), ...later])).toBe(true);
  });
});
