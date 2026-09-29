import { InvalidAssistantPlanError } from './errors';

export const Intent = {
  Summary: 'summary',
  Explain: 'explain',
  Edit: 'edit',
} as const;
export type Intent = (typeof Intent)[keyof typeof Intent];

export const Evidence = {
  LineContext: 'line_context',
  Selection: 'selection',
  Logs: 'logs',
} as const;
export type Evidence = (typeof Evidence)[keyof typeof Evidence];

export interface AssistantPlan {
  readonly intent: Intent;
  readonly needs: readonly Evidence[];
  readonly reason: string;
}

const INTENTS: readonly string[] = Object.values(Intent);
const EVIDENCE: readonly string[] = Object.values(Evidence);

function isIntent(value: unknown): value is Intent {
  return typeof value === 'string' && INTENTS.includes(value);
}

function isEvidence(value: unknown): value is Evidence {
  return typeof value === 'string' && EVIDENCE.includes(value);
}

export function createAssistantPlan(input: {
  intent: unknown;
  needs?: unknown;
  reason?: unknown;
}): AssistantPlan {
  const { intent } = input;
  if (!isIntent(intent)) {
    throw new InvalidAssistantPlanError(`unknown intent: ${JSON.stringify(intent)}`);
  }
  if (input.reason !== undefined && typeof input.reason !== 'string') {
    throw new InvalidAssistantPlanError('reason must be a string');
  }
  const needs = input.needs === undefined ? [] : input.needs;
  if (!Array.isArray(needs)) throw new InvalidAssistantPlanError('needs must be an array');
  const evidence = needs.map((need: unknown) => {
    if (!isEvidence(need)) {
      throw new InvalidAssistantPlanError(`unknown evidence: ${JSON.stringify(need)}`);
    }
    return need;
  });
  const unique = new Set(evidence);
  if (unique.size !== evidence.length) {
    throw new InvalidAssistantPlanError(`needs lists evidence twice: ${JSON.stringify(needs)}`);
  }
  return Object.freeze({
    intent,
    needs: Object.freeze(evidence),
    reason: (input.reason ?? '').trim(),
  });
}
