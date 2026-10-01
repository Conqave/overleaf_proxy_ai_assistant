import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ApplyDocumentChange } from '../../../src/application/apply-document-change';
import { ConversationLog } from '../../../src/application/conversation-log';
import { StartNewConversation } from '../../../src/application/conversation-session';
import { HandleAssistantRequest } from '../../../src/application/handle-assistant-request';
import { OperationLock } from '../../../src/application/operation-lock';
import { PendingChanges } from '../../../src/application/pending-change';
import { RejectDocumentChange } from '../../../src/application/reject-document-change';
import { ReviewAppliedChange } from '../../../src/application/review-applied-change';
import type { CompileDiagnostic } from '../../../src/domain/agent-transcript';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { InvariantViolation } from '../../../src/domain/errors';
import { AssistantController } from '../../../src/presentation/assistant-controller';
import { AssistantView } from '../../../src/presentation/assistant-view';
import {
  FakeAgent,
  FakeEditor,
  FakeProject,
  InMemoryConversationRepository,
  sequentialIds,
} from '../../support/fakes';
import { TestFixtureError } from '../../support/test-errors';

const BIB = ['@article{smith20}', '}'];

async function openAssistant() {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const editor = new FakeEditor([]);
  const project = new FakeProject(
    editor,
    { 'main.tex': ['\\cite{knuth84}'], 'refs.bib': BIB },
    'main.tex',
  );
  const agent = new FakeAgent().will(
    { kind: 'tool', call: { tool: 'read_file', path: 'refs.bib' } },
    {
      kind: 'reply',
      reply: {
        kind: 'edit',
        path: 'refs.bib',
        command: createDocumentCommand({
          operation: 'insert_after',
          target: { lineNumber: 2, lineText: '}' },
          content: '@book{knuth84}',
          reason: 'Adds the missing entry.',
        }),
      },
    },
  );
  const conversation = new ConversationLog(new InMemoryConversationRepository());
  const pendingChanges = new PendingChanges();
  const lock = new OperationLock(() => new AbortController());
  const handleRequest = new HandleAssistantRequest({
    agent,
    project,
    editor,
    conversation,
    pendingChanges,
    lock,
    newId: sequentialIds(),
  });
  const review = new ReviewAppliedChange({ project, conversation, handleRequest });
  const controller = new AssistantController({
    handleRequest,
    lock,
    applyChange: new ApplyDocumentChange({
      editor,
      project,
      pendingChanges,
      conversation,
      lock,
      review,
    }),
    rejectChange: new RejectDocumentChange({ editor, pendingChanges, conversation }),
    startNewConversation: new StartNewConversation({
      conversation,
      pendingChanges,
      editor,
      lock,
    }),
    conversation,
  });
  await controller.attach(new AssistantView(window.document, controller));
  const texts = (selector: string) =>
    Array.from(window.document.querySelectorAll(selector)).map((n) => n.textContent);
  return { window, controller, conversation, editor, project, agent, texts };
}

async function proposeBibEdit() {
  const assistant = await openAssistant();
  await assistant.controller.send('add the knuth84 entry');
  const proposal = assistant.conversation.messages().at(-1);
  if (proposal?.role !== 'assistant' || proposal.kind !== 'proposal') {
    throw new TestFixtureError('the controller did not show a proposal');
  }
  return { ...assistant, changeId: proposal.id };
}

describe('AssistantController context usage', () => {
  it('shows an unused context window before the first request', async () => {
    const { texts } = await openAssistant();
    expect(texts('.ola-context')).toEqual(['Context 0 / 98.3k']);
  });

  it('shows the context usage of the last request and an unused window for a new chat', async () => {
    const { controller, texts } = await proposeBibEdit();
    expect(texts('.ola-context')).toEqual(['Context 2.0k / 98.3k']);
    await controller.newConversation();
    expect(texts('.ola-context')).toEqual(['Context 0 / 98.3k']);
  });

  it('shows the context usage of the fix proposed after a failed compilation', async () => {
    const { controller, project, agent, changeId, texts } = await proposeBibEdit();
    project.willCompile([{ level: 'error', message: 'Missing } inserted.' }]);
    agent.will({ kind: 'reply', reply: { kind: 'answer', text: 'Add a closing brace.' } });
    await controller.apply(changeId);
    expect(texts('.ola-context')).toEqual(['Context 3.0k / 98.3k']);
  });
});

describe('AssistantController apply', () => {
  it('reports the applied file and a clean compilation', async () => {
    const { controller, project, changeId, texts } = await proposeBibEdit();
    project.willCompile([]);
    await controller.apply(changeId);
    expect(texts('.ola-system')).toEqual([
      'Done. Inserted after the selected anchor in refs.bib.',
      'Compiled without errors.',
    ]);
  });

  it('keeps the applied proposal as a card marked applied', async () => {
    const { controller, project, changeId, texts } = await proposeBibEdit();
    project.willCompile([]);
    await controller.apply(changeId);
    expect(texts('.ola-ai.is-applied .ola-result-status')).toEqual(['Applied']);
    expect(texts('.ola-ai.is-applied .ola-result-meta')).toEqual(['refs.bib, anchor line 2: }']);
    expect(texts('.ola-apply')).toEqual([]);
  });
});

describe('AssistantController reject', () => {
  it('keeps the rejected proposal as a card marked rejected instead of a notice', async () => {
    const { controller, changeId, texts } = await proposeBibEdit();
    await controller.reject(changeId);
    expect(texts('.ola-ai.is-rejected .ola-result-status')).toEqual(['Rejected']);
    expect(texts('.ola-ai.is-rejected .ola-result-meta')).toEqual(['refs.bib, anchor line 2: }']);
    expect(texts('.ola-ai.is-rejected .ola-result-body')).toEqual(['@book{knuth84}']);
    expect(texts('.ola-apply')).toEqual([]);
    expect(texts('.ola-system')).toEqual([]);
  });

  it('shows the fix proposed after a failed compilation', async () => {
    const { controller, project, agent, changeId, texts } = await proposeBibEdit();
    project.willCompile([{ level: 'error', message: 'Missing } inserted.' }]);
    agent.will({ kind: 'reply', reply: { kind: 'answer', text: 'Add a closing brace.' } });
    await controller.apply(changeId);
    expect(texts('.ola-result-body').at(-1)).toBe('Add a closing brace.');
  });

  it('shows expected failures and continues', async () => {
    const { controller, editor, changeId, texts } = await proposeBibEdit();
    editor.lines[1] = 'Edited meanwhile.';
    await expect(controller.apply(changeId)).resolves.toBeUndefined();
    expect(texts('.ola-error')).toEqual([
      expect.stringContaining('The document changed after the suggestion was made.'),
    ]);
    expect(texts('.ola-status')).toEqual(['']);
  });

  it('does not disguise defects as user errors', async () => {
    const { controller, editor, changeId, texts } = await proposeBibEdit();
    const defect = new InvariantViolation('broken');
    editor.applyFailure = defect;
    await expect(controller.apply(changeId)).rejects.toBe(defect);
    expect(texts('.ola-error')).toEqual([
      'Unexpected internal error. Details are in the browser console.',
    ]);
  });
});

describe('AssistantController new chat', () => {
  it('shows nothing for a request the user cancelled with a new chat', async () => {
    const { controller, project, texts } = await openAssistant();
    project.holdsReads = true;
    const sending = controller.send('add the knuth84 entry');
    await vi.waitFor(() => {
      expect(project.reads).toEqual(['refs.bib']);
    });
    await controller.newConversation();
    await sending;
    expect(texts('.ola-error')).toEqual([]);
    expect(texts('.ola-msg')).toEqual([expect.stringContaining('Ready to help')]);
  });
});

describe('AssistantView while an operation runs', () => {
  it('shows the busy state of the operation lock and ignores Enter until it ends', async () => {
    const { window, controller, project, changeId, texts } = await proposeBibEdit();
    const compiled = Promise.withResolvers<readonly CompileDiagnostic[]>();
    project.compile = () => compiled.promise;
    const applying = controller.apply(changeId);
    const input = window.document.querySelector('textarea');
    if (input === null) throw new TestFixtureError('the view has no input');
    expect(window.document.querySelector('#ola-root')?.classList.contains('is-busy')).toBe(true);
    input.value = 'second request';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(input.value).toBe('second request');
    compiled.resolve([]);
    await applying;
    expect(texts('.ola-error')).toEqual([]);
    expect(texts('.ola-user')).toEqual(['add the knuth84 entry']);
    expect(window.document.querySelector('#ola-root')?.classList.contains('is-busy')).toBe(false);
  });
});
