import { describe, expect, it } from 'vitest';
import {
  checkFilesChecked,
  checkReply,
  checkToolCall,
  countToolCallsLeft,
  createAgentPolicies,
  hasMistakesLeft,
  SUBAGENT_POLICY,
} from '../../../src/domain/agent-policy';
import { WEB_SEARCH_DENIED } from '../../../src/domain/web-search';
import { MAIN_AGENT_POLICY, WEB_POLICIES } from '../../support/policies';
import { findUncheckedFiles, type AgentTurn } from '../../../src/domain/agent-transcript';
import { finishDelegation } from '../../../src/domain/delegation';
import { createDocumentSnapshot } from '../../../src/domain/document';
import {
  DelegationLimitError,
  ReplyNotAllowedError,
  RepeatedToolCallError,
  ScopedSearchNotAllowedError,
  ToolBudgetExhaustedError,
  ToolNotAllowedError,
  UncheckedFilesError,
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

  it('explains why repeating a cut search is useless and what to do instead', () => {
    const cut: AgentTurn = {
      kind: 'tool',
      call: { tool: 'search', query: '\\cite' },
      result: { tool: 'search', matches: [], truncated: true },
    };
    const problem =
      'search was already called with the same argument and its result was cut, so repeating it shows nothing new; search for something narrower';
    expect(() => {
      checkToolCall(MAIN, [cut], { tool: 'search', query: '\\cite' });
    }).toThrow(new RepeatedToolCallError(`${problem}, or delegate the whole check`));
    expect(() => {
      checkToolCall(SUBAGENT_POLICY, [cut], { tool: 'search', query: '\\cite' });
    }).toThrow(new RepeatedToolCallError(`${problem} or only in one file or folder`));
  });

  it('lets only the subagent search in one file or folder', () => {
    const scoped = { tool: 'search', query: '\\cite', path: 'chapters' } as const;
    expect(() => {
      checkToolCall(MAIN, [], scoped);
    }).toThrow(ScopedSearchNotAllowedError);
    expect(() => {
      checkToolCall(SUBAGENT_POLICY, [], scoped);
    }).not.toThrow();
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
    const used = repeat(MAIN.maxDelegations - 1, (i) => delegateTurn(task(i)));
    expect(() => {
      checkToolCall(MAIN, used, { tool: 'delegate', task: task(9), files: [] });
    }).not.toThrow();
  });

  it('gives the subagent no delegations', () => {
    expect(SUBAGENT_POLICY.maxDelegations).toBe(0);
  });

  it('refuses a delegation beyond the limit even with lookups left', () => {
    const used = repeat(MAIN.maxDelegations, (i) => delegateTurn(task(i)));
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

describe('web search policy', () => {
  const search = { tool: 'web_search', query: 'Lamport LaTeX DOI' } as const;
  const deniedTurn: AgentTurn = {
    kind: 'tool',
    call: search,
    result: { tool: 'web_search', outcome: WEB_SEARCH_DENIED },
  };

  it('gives the main agent web_search only when the deployment enables it', () => {
    expect(createAgentPolicies({ webSearch: false }).main.tools).not.toContain('web_search');
    expect(WEB_POLICIES.main.tools).toEqual([
      'read_file',
      'search',
      'compile',
      'delegate',
      'web_search',
    ]);
    expect(() => {
      checkToolCall(MAIN, [], search);
    }).toThrow(ToolNotAllowedError);
    expect(() => {
      checkToolCall(WEB_POLICIES.main, [], search);
    }).not.toThrow();
  });

  it('never gives the subagent web_search', () => {
    expect(WEB_POLICIES.subagent).toBe(SUBAGENT_POLICY);
    expect(() => {
      checkToolCall(WEB_POLICIES.subagent, [], search);
    }).toThrow(ToolNotAllowedError);
  });

  it('charges a web search, even a denied one, to the lookups', () => {
    expect(countToolCallsLeft(WEB_POLICIES.main, [deniedTurn])).toBe(
      WEB_POLICIES.main.maxToolCalls - 1,
    );
    const full = repeat(WEB_POLICIES.main.maxToolCalls, (i) => readTurn(`f${String(i)}.tex`));
    expect(() => {
      checkToolCall(WEB_POLICIES.main, full, search);
    }).toThrow(ToolBudgetExhaustedError);
  });

  it('refuses the same web search after a denial', () => {
    expect(() => {
      checkToolCall(WEB_POLICIES.main, [deniedTurn], search);
    }).toThrow(RepeatedToolCallError);
    expect(() => {
      checkToolCall(WEB_POLICIES.main, [deniedTurn], { ...search, query: 'LaTeX ISBN' });
    }).not.toThrow();
  });
});

describe('files a subagent has to check', () => {
  const searchTurn = (path: string | undefined, truncated: boolean): AgentTurn => ({
    kind: 'tool',
    call:
      path === undefined ? { tool: 'search', query: 'k' } : { tool: 'search', query: 'k', path },
    result: { tool: 'search', matches: [], truncated },
  });
  const files = ['ch/a.tex', 'ch/b.tex', 'refs.bib'];

  it('counts a read file and every file a complete search covered as checked', () => {
    expect(findUncheckedFiles(files, [readTurn('refs.bib')])).toEqual(['ch/a.tex', 'ch/b.tex']);
    expect(findUncheckedFiles(files, [searchTurn('ch', false)])).toEqual(['refs.bib']);
    expect(findUncheckedFiles(files, [searchTurn(undefined, false)])).toEqual([]);
  });

  it('does not count a cut search or a rejected step as checking', () => {
    expect(findUncheckedFiles(files, [searchTurn('ch', true), mistakeTurn('refs.bib')])).toEqual(
      files,
    );
  });

  it('refuses findings while files are unchecked and lookups are left', () => {
    expect(() => {
      checkFilesChecked(SUBAGENT_POLICY, [readTurn('refs.bib')], files);
    }).toThrow(
      new UncheckedFilesError(
        'ch/a.tex, ch/b.tex of the task are not checked yet; read_file or search each of them before you reply',
      ),
    );
    expect(() => {
      checkFilesChecked(SUBAGENT_POLICY, [searchTurn(undefined, false)], files);
    }).not.toThrow();
  });

  it('accepts findings once the lookups are used up', () => {
    const full = repeat(SUBAGENT_POLICY.maxToolCalls, (i) => readTurn(`x${String(i)}.tex`));
    expect(() => {
      checkFilesChecked(SUBAGENT_POLICY, full, files);
    }).not.toThrow();
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
  const limit = MAIN.maxConsecutiveMistakes;

  it('allows fewer consecutive mistakes than the limit', () => {
    expect(hasMistakesLeft(MAIN, [])).toBe(true);
    expect(
      hasMistakesLeft(
        MAIN,
        repeat(limit - 1, (i) => mistakeTurn(`m${String(i)}`)),
      ),
    ).toBe(true);
  });

  it('takes the limit of consecutive mistakes from the policy of the role', () => {
    const strict = { ...SUBAGENT_POLICY, maxConsecutiveMistakes: 1 };
    expect(hasMistakesLeft(strict, [mistakeTurn('m')])).toBe(false);
    expect(hasMistakesLeft(SUBAGENT_POLICY, [mistakeTurn('m')])).toBe(true);
  });

  it('stops at the limit of consecutive mistakes', () => {
    expect(
      hasMistakesLeft(
        MAIN,
        repeat(limit, (i) => mistakeTurn(`m${String(i)}`)),
      ),
    ).toBe(false);
  });

  it('counts only the mistakes after the last tool call', () => {
    const earlier = repeat(limit - 1, (i) => mistakeTurn(`e${String(i)}`));
    const later = repeat(limit - 1, (i) => mistakeTurn(`l${String(i)}`));
    expect(hasMistakesLeft(MAIN, [...earlier, readTurn('a.tex'), ...later])).toBe(true);
  });
});
