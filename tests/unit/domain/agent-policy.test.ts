import { describe, expect, it } from 'vitest';
import { AGENT_POLICY, canCallTools, checkToolCall } from '../../../src/domain/agent-policy';
import type { AgentTurn } from '../../../src/domain/agent-transcript';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { RepeatedToolCallError, ToolBudgetExhaustedError } from '../../../src/domain/errors';

function readTurn(path: string): AgentTurn {
  return {
    call: { tool: 'read_file', path },
    result: { tool: 'read_file', path, document: createDocumentSnapshot(['x']) },
  };
}

const compileTurn: AgentTurn = {
  call: { tool: 'compile' },
  result: { tool: 'compile', diagnostics: [] },
};

describe('agent tool policy', () => {
  it('allows a new call within the budget', () => {
    expect(canCallTools([])).toBe(true);
    expect(() => {
      checkToolCall([readTurn('a.tex')], { tool: 'read_file', path: 'b.tex' });
    }).not.toThrow();
  });

  it('stops tool calls once the budget is used', () => {
    const full = Array.from({ length: AGENT_POLICY.maxToolCalls }, (_, i) =>
      readTurn(`f${String(i)}.tex`),
    );
    expect(canCallTools(full)).toBe(false);
    expect(() => {
      checkToolCall(full, { tool: 'search', query: 'abc' });
    }).toThrow(ToolBudgetExhaustedError);
  });

  it('rejects repeating a call', () => {
    expect(() => {
      checkToolCall([readTurn('a.tex')], { tool: 'read_file', path: 'a.tex' });
    }).toThrow(RepeatedToolCallError);
  });

  it('allows one compilation per request', () => {
    expect(() => {
      checkToolCall([compileTurn], { tool: 'compile' });
    }).toThrow(RepeatedToolCallError);
  });
});
