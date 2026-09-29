import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { DocumentConflictError, InvariantViolation } from '../../../src/domain/errors';
import { AssistantController, type UseCases } from '../../../src/presentation/assistant-controller';
import { AssistantView } from '../../../src/presentation/assistant-view';

function setup(applyError: Error) {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const useCases = {
    conversation: { restore: () => [], takePersistenceFailure: () => null },
    applyChange: {
      execute: () => {
        throw applyError;
      },
    },
  } as unknown as UseCases;
  const controller = new AssistantController(useCases);
  controller.attach(new AssistantView(window.document, controller));
  const notices = () =>
    Array.from(window.document.querySelectorAll('.ola-error')).map((n) => n.textContent);
  return { controller, notices };
}

describe('AssistantController error handling', () => {
  it('shows expected failures and continues', () => {
    const { controller, notices } = setup(new DocumentConflictError('Document changed.'));
    expect(() => {
      controller.apply('c1');
    }).not.toThrow();
    expect(notices()).toEqual(['Error: Document changed.']);
  });

  it('does not disguise defects as user errors', () => {
    const defect = new InvariantViolation('broken');
    const { controller, notices } = setup(defect);
    expect(() => {
      controller.apply('c1');
    }).toThrow(defect);
    expect(notices()).toEqual(['Unexpected internal error. Details are in the browser console.']);
  });
});
