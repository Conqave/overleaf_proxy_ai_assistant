import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { DocumentConflictError, InvariantViolation } from '../../../src/domain/errors';
import { AssistantController, type UseCases } from '../../../src/presentation/assistant-controller';
import { AssistantView } from '../../../src/presentation/assistant-view';

async function setup(applyError: Error) {
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
  await controller.attach(new AssistantView(window.document, controller));
  const notices = () =>
    Array.from(window.document.querySelectorAll('.ola-error')).map((n) => n.textContent);
  return { controller, notices };
}

describe('AssistantController error handling', () => {
  it('shows expected failures and continues', async () => {
    const { controller, notices } = await setup(new DocumentConflictError('Document changed.'));
    await expect(controller.apply('c1')).resolves.toBeUndefined();
    expect(notices()).toEqual(['Error: Document changed.']);
  });

  it('does not disguise defects as user errors', async () => {
    const defect = new InvariantViolation('broken');
    const { controller, notices } = await setup(defect);
    await expect(controller.apply('c1')).rejects.toBe(defect);
    expect(notices()).toEqual(['Unexpected internal error. Details are in the browser console.']);
  });
});
