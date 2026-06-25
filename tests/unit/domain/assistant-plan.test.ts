import { describe, expect, it } from 'vitest';
import { createAssistantPlan } from '../../../src/domain/assistant-plan';
import { InvalidAssistantPlanError } from '../../../src/domain/errors';

describe('createAssistantPlan', () => {
  it('accepts an edit plan and de-duplicates needs', () => {
    expect(
      createAssistantPlan({ intent: 'edit', needs: ['logs', 'selection', 'logs'], reason: 'r' }),
    ).toEqual({ intent: 'edit', needs: ['logs', 'selection'], reason: 'r' });
  });

  it('treats needs and reason as optional', () => {
    expect(createAssistantPlan({ intent: 'summary' })).toEqual({
      intent: 'summary',
      needs: [],
      reason: '',
    });
  });

  it.each([
    ['unknown intent', { intent: 'insert' }],
    [
      'a clarification, which only the step that sees the document may ask for',
      { intent: 'clarify' },
    ],
    ['unknown need', { intent: 'summary', needs: ['everything'] }],
    ['needs not an array', { intent: 'summary', needs: 'logs' }],
    ['the document as a need, which is always given', { intent: 'summary', needs: ['document'] }],
    ['non-string reason', { intent: 'summary', reason: 3 }],
  ])('rejects %s', (_name, input) => {
    expect(() => createAssistantPlan(input)).toThrow(InvalidAssistantPlanError);
  });
});
