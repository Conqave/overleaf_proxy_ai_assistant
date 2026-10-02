import { describe, expect, it } from 'vitest';
import {
  AGENT_POLICY,
  checkReply,
  checkToolCall,
  countToolCallsLeft,
  hasMistakesLeft,
  MAIN_AGENT_POLICY,
  SUBAGENT_POLICY,
} from '../../../src/domain/agent-policy';
import type { AgentTurn } from '../../../src/domain/agent-transcript';
import { finishDelegation } from '../../../src/domain/delegation';
import { createDocumentSnapshot } from '../../../src/domain/document';
import {
  DelegationLimitError,
  ReplyNotAllowedError,
  RepeatedToolCallError,
  ToolBudgetExhaustedError,
  ToolNotAllowedError,
} from '../../../src/domain/errors';

const MAIN = MAIN_AGENT_POLICY;

function readTurn(path: string): AgentTurn {
  return {
    kind: 'tool',
    call: { tool: 'read_file', path },
    result: {
      tool: 'read_file',
      path,
      document: createDocumentSnapshot(['x']),
      shown: { first: 1, last: 1 },
    },
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

function delegateTurn(task: string): AgentTurn {
  return {
    kind: 'tool',
    call: { tool: 'delegate', task, files: [] },
    result: { tool: 'delegate', report: finishDelegation('No findings.', 1) },
  };
}

const repeat = <T>(count: number, create: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => create(index));

describe('agent tool policy', () => {
  it('allows a new call within the budget', () => {
    expect(countToolCallsLeft(MAIN, [])).toBe(MAIN.maxToolCalls);
    expect(() => {
      checkToolCall(MAIN, [readTurn('a.tex')], { tool: 'read_file', path: 'b.tex' });
    }).not.toThrow();
  });

  it('stops tool calls once the budget is used', () => {
    const full = repeat(MAIN.maxToolCalls, (i) => readTurn(`f${String(i)}.tex`));
    expect(countToolCallsLeft(MAIN, full)).toBe(0);
    expect(() => {
      checkToolCall(MAIN, full, { tool: 'search', query: 'abc' });
    }).toThrow(ToolBudgetExhaustedError);
  });

  it('does not charge rejected steps to the tool budget', () => {
    expect(countToolCallsLeft(MAIN, [mistakeTurn('a.tex'), readTurn('b.tex')])).toBe(
      MAIN.maxToolCalls - 1,
    );
  });

  it('rejects repeating a call', () => {
    expect(() => {
      checkToolCall(MAIN, [readTurn('a.tex')], { tool: 'read_file', path: 'a.tex' });
    }).toThrow(RepeatedToolCallError);
  });

  it('lets a call that was rejected before be made again', () => {
    expect(() => {
      checkToolCall(MAIN, [mistakeTurn('a.tex')], { tool: 'read_file', path: 'a.tex' });
    }).not.toThrow();
  });

  it('allows one compilation per request', () => {
    expect(() => {
      checkToolCall(MAIN, [compileTurn], { tool: 'compile' });
    }).toThrow(RepeatedToolCallError);
  });
});

describe('delegation policy', () => {
  const task = (index: number): string => `Check every citation of chapter ${String(index)}`;

  it('lets the main agent delegate up to its limit of delegations per request', () => {
    const used = repeat(AGENT_POLICY.maxDelegations - 1, (i) => delegateTurn(task(i)));
    expect(() => {
      checkToolCall(MAIN, used, { tool: 'delegate', task: task(9), files: [] });
    }).not.toThrow();
  });

  it('refuses a delegation beyond the limit even with lookups left', () => {
    const used = repeat(AGENT_POLICY.maxDelegations, (i) => delegateTurn(task(i)));
    expect(countToolCallsLeft(MAIN, used)).toBeGreaterThan(0);
    expect(() => {
      checkToolCall(MAIN, used, { tool: 'delegate', task: task(9), files: [] });
    }).toThrow(DelegationLimitError);
  });

  it('charges a delegation to the lookups of the main agent', () => {
    expect(countToolCallsLeft(MAIN, [delegateTurn(task(1))])).toBe(MAIN.maxToolCalls - 1);
  });

  it('treats the same task as a repeated delegation', () => {
    expect(() => {
      checkToolCall(MAIN, [delegateTurn(task(1))], {
        tool: 'delegate',
        task: task(1),
        files: ['a.tex'],
      });
    }).toThrow(RepeatedToolCallError);
  });

  it('gives the subagent only read_file and search', () => {
    expect(SUBAGENT_POLICY.tools).toEqual(['read_file', 'search']);
    expect(() => {
      checkToolCall(SUBAGENT_POLICY, [], { tool: 'search', query: '\\cite{' });
    }).not.toThrow();
  });

  it('forbids the subagent to delegate further', () => {
    expect(() => {
      checkToolCall(SUBAGENT_POLICY, [], { tool: 'delegate', task: task(1), files: [] });
    }).toThrow(
      new ToolNotAllowedError(
        'delegate is not available in this task; use only read_file or search',
      ),
    );
  });

  it('forbids the subagent to compile', () => {
    expect(() => {
      checkToolCall(SUBAGENT_POLICY, [], { tool: 'compile' });
    }).toThrow(ToolNotAllowedError);
  });

  it('gives the subagent a step limit of its own', () => {
    const full = repeat(SUBAGENT_POLICY.maxToolCalls, (i) => readTurn(`f${String(i)}.tex`));
    expect(countToolCallsLeft(SUBAGENT_POLICY, full)).toBe(0);
    expect(() => {
      checkToolCall(SUBAGENT_POLICY, full, { tool: 'search', query: 'abc' });
    }).toThrow(
      new ToolBudgetExhaustedError(
        `all ${String(SUBAGENT_POLICY.maxToolCalls)} lookups are used; reply now with answer`,
      ),
    );
  });
});

describe('reply policy', () => {
  it('lets the main agent answer, ask and edit', () => {
    for (const reply of [
      { kind: 'answer', text: 'a' },
      { kind: 'question', text: 'q' },
      { kind: 'edit', edits: [] },
    ] as const) {
      expect(() => {
        checkReply(MAIN, reply);
      }).not.toThrow();
    }
  });

  it('lets the subagent only answer', () => {
    expect(() => {
      checkReply(SUBAGENT_POLICY, { kind: 'answer', text: 'Found.' });
    }).not.toThrow();
    expect(() => {
      checkReply(SUBAGENT_POLICY, { kind: 'edit', edits: [] });
    }).toThrow(new ReplyNotAllowedError('edit is not available in this task; reply with answer'));
    expect(() => {
      checkReply(SUBAGENT_POLICY, { kind: 'question', text: 'Which file?' });
    }).toThrow(ReplyNotAllowedError);
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
