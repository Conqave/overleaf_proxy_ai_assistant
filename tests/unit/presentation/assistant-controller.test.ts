import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { ApplyDocumentChange } from '../../../src/application/apply-document-change';
import { ConversationLog } from '../../../src/application/conversation-log';
import { StartNewConversation } from '../../../src/application/conversation-session';
import { HandleAssistantRequest } from '../../../src/application/handle-assistant-request';
import { PendingChanges } from '../../../src/application/pending-change';
import { RejectDocumentChange } from '../../../src/application/reject-document-change';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { InvariantViolation } from '../../../src/domain/errors';
import { ResolvedEdit } from '../../../src/domain/resolved-edit';
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

async function proposeBibEdit() {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const editor = new FakeEditor([]);
  const documents = { 'main.tex': ['\\cite{knuth84}'], 'refs.bib': [...BIB] };
  const project = new FakeProject(editor, documents, 'main.tex');
  const agent = new FakeAgent().will(
    { kind: 'tool', call: { tool: 'read_file', path: 'refs.bib' } },
    {
      kind: 'reply',
      reply: {
        kind: 'edit',
        change: {
          path: 'refs.bib',
          edit: ResolvedEdit.resolve(
            createDocumentSnapshot(BIB),
            createDocumentCommand({
              operation: 'insert_after',
              target: { lineNumber: 2, lineText: '}' },
              content: '@book{knuth84}',
              reason: 'Adds the missing entry.',
            }),
          ),
        },
      },
    },
  );
  const conversation = new ConversationLog(new InMemoryConversationRepository());
  const pendingChanges = new PendingChanges();
  const controller = new AssistantController({
    handleRequest: new HandleAssistantRequest({
      agent,
      project,
      editor,
      conversation,
      pendingChanges,
      newId: sequentialIds(),
    }),
    applyChange: new ApplyDocumentChange({ editor, project, pendingChanges }),
    rejectChange: new RejectDocumentChange({ editor, pendingChanges, conversation }),
    startNewConversation: new StartNewConversation({ conversation, pendingChanges, editor }),
    conversation,
  });
  await controller.attach(new AssistantView(window.document, controller));
  await controller.send('add the knuth84 entry');
  const proposal = conversation.messages().at(-1);
  if (proposal?.role !== 'assistant' || proposal.kind !== 'proposal') {
    throw new TestFixtureError('the controller did not show a proposal');
  }
  const texts = (selector: string) =>
    Array.from(window.document.querySelectorAll(selector)).map((n) => n.textContent);
  return { controller, editor, documents, changeId: proposal.id, texts };
}

describe('AssistantController apply', () => {
  it('reports the applied file', async () => {
    const { controller, changeId, texts } = await proposeBibEdit();
    await controller.apply(changeId);
    expect(texts('.ola-system')).toEqual(['Done. Inserted after the selected anchor in refs.bib.']);
  });

  it('shows expected failures and continues', async () => {
    const { controller, documents, changeId, texts } = await proposeBibEdit();
    documents['refs.bib'][1] = 'Edited meanwhile.';
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
