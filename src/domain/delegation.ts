import { InvalidToolRecordError } from './errors';

export const MAX_DELEGATION_RESULT_CHARS = 1_500;

export const DelegationOutcome = {
  Finished: 'finished',
  Failed: 'failed',
} as const;
export type DelegationOutcome = (typeof DelegationOutcome)[keyof typeof DelegationOutcome];

export type DelegationReport =
  | {
      readonly outcome: typeof DelegationOutcome.Finished;
      readonly text: string;
      readonly truncated: boolean;
      readonly lookups: number;
    }
  | {
      readonly outcome: typeof DelegationOutcome.Failed;
      readonly problem: string;
      readonly lookups: number;
    };

export function finishDelegation(text: string, lookups: number): DelegationReport {
  const result = text.trim();
  const truncated = result.length > MAX_DELEGATION_RESULT_CHARS;
  return createDelegationReport({
    outcome: DelegationOutcome.Finished,
    text: truncated ? result.slice(0, MAX_DELEGATION_RESULT_CHARS) : result,
    truncated,
    lookups,
  });
}

export function failDelegation(problem: string, lookups: number): DelegationReport {
  return createDelegationReport({
    outcome: DelegationOutcome.Failed,
    problem: problem.trim().slice(0, MAX_DELEGATION_RESULT_CHARS),
    lookups,
  });
}

export function createDelegationReport(report: DelegationReport): DelegationReport {
  const { lookups } = report;
  if (!Number.isInteger(lookups) || lookups < 0) {
    throw new InvalidToolRecordError(`a subagent cannot make ${String(lookups)} lookups`);
  }
  switch (report.outcome) {
    case DelegationOutcome.Finished:
      checkResultText('result', report.text);
      return Object.freeze({ ...report });
    case DelegationOutcome.Failed:
      checkResultText('problem', report.problem);
      return Object.freeze({ ...report });
  }
}

function checkResultText(name: string, text: string): void {
  if (text.trim() === '') throw new InvalidToolRecordError(`the subagent's ${name} is empty`);
}
