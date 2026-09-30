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
  FakeAssistant,
  FakeEditor,
  InMemoryConversationRepository,
  sequentialIds,
} from '../../support/fakes';
import { TestFixtureError } from '../../support/test-errors';

const DOC = ['\\section{Intro}', 'Numbers.'];

async function proposeEdit() {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const editor = new FakeEditor([...DOC]);
  const assistant = new FakeAssistant().willPlan({ intent: 'edit', needs: [] }).willReply({
    kind: 'edit',
    rationale: 'After the numbers.',
    edit: ResolvedEdit.resolve(
      createDocumentSnapshot(DOC),
      createDocumentCommand({
        operation: 'insert_after',
        target: { lineNumber: 2, lineText: 'Numbers.' },
        content: 'More numbers.',
        reason: 'Adds detail.',
      }),
    ),
  });
  const conversation = new ConversationLog(new InMemoryConversationRepository());
  const pendingChanges = new PendingChanges();
  const controller = new AssistantController({
    handleRequest: new HandleAssistantRequest({
      assistant,
      editor,
      conversation,
      pendingChanges,
      newId: sequentialIds(),
    }),
    applyChange: new ApplyDocumentChange({ editor, pendingChanges }),
    rejectChange: new RejectDocumentChange({ editor, pendingChanges, conversation }),
    startNewConversation: new StartNewConversation({ conversation, pendingChanges, editor }),
    conversation,
  });
  await controller.attach(new AssistantView(window.document, controller));
  await controller.send('add more numbers');
  const proposal = conversation.messages().at(-1);
  if (proposal?.role !== 'assistant' || proposal.kind !== 'proposal') {
    throw new TestFixtureError('the controller did not show a proposal');
  }
  const notices = () =>
    Array.from(window.document.querySelectorAll('.ola-error')).map((n) => n.textContent);
  return { controller, editor, changeId: proposal.id, notices };
}

describe('AssistantController error handling', () => {
  it('shows expected failures and continues', async () => {
    const { controller, editor, changeId, notices } = await proposeEdit();
    editor.lines[1] = 'Edited meanwhile.';
    await expect(controller.apply(changeId)).resolves.toBeUndefined();
    expect(notices()).toEqual([
      expect.stringContaining('The document changed after the suggestion was made.'),
    ]);
  });

  it('does not disguise defects as user errors', async () => {
    const { controller, editor, changeId, notices } = await proposeEdit();
    const defect = new InvariantViolation('broken');
    editor.applyFailure = defect;
    await expect(controller.apply(changeId)).rejects.toBe(defect);
    expect(notices()).toEqual(['Unexpected internal error. Details are in the browser console.']);
  });
});
