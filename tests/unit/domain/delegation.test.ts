import { describe, expect, it } from 'vitest';
import { SUBAGENT_POLICY } from '../../../src/domain/agent-policy';
import { MAX_DELEGATION_RESULT_CHARS } from '../../../src/domain/delegation';
import {
  createDelegationReport,
  failDelegation,
  finishDelegation,
} from '../../../src/domain/delegation';
import { InvalidToolRecordError } from '../../../src/domain/errors';

const LIMIT = MAX_DELEGATION_RESULT_CHARS;

describe('delegation report', () => {
  it('keeps short findings whole', () => {
    expect(finishDelegation('  main.tex:4 \\cite{a}: missing \n', 2)).toEqual({
      outcome: 'finished',
      text: 'main.tex:4 \\cite{a}: missing',
      truncated: false,
      lookups: 2,
    });
  });

  it('cuts findings at the policy limit and says so', () => {
    const report = finishDelegation('y'.repeat(LIMIT * 2), 1);
    expect(report).toEqual({
      outcome: 'finished',
      text: 'y'.repeat(LIMIT),
      truncated: true,
      lookups: 1,
    });
  });

  it('keeps the problem of a failed delegation within the limit', () => {
    expect(failDelegation('z'.repeat(LIMIT + 1), 0)).toEqual({
      outcome: 'failed',
      problem: 'z'.repeat(LIMIT),
      lookups: 0,
    });
  });

  it('restores a report made under other limits than the current ones', () => {
    const report = {
      outcome: 'finished',
      text: 'x'.repeat(LIMIT * 2),
      truncated: false,
      lookups: SUBAGENT_POLICY.maxToolCalls * 2,
    } as const;
    expect(createDelegationReport(report)).toEqual(report);
  });

  it.each([
    ['empty findings', { outcome: 'finished', text: ' ', truncated: false, lookups: 0 }],
    ['an empty problem', { outcome: 'failed', problem: '', lookups: 0 }],
    ['negative lookups', { outcome: 'failed', problem: 'p', lookups: -1 }],
    ['fractional lookups', { outcome: 'failed', problem: 'p', lookups: 1.5 }],
  ] as const)('rejects %s', (_, report) => {
    expect(() => createDelegationReport(report)).toThrow(InvalidToolRecordError);
  });
});
