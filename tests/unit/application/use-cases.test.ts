import { beforeEach, describe, expect, it } from 'vitest';
import { ApplyDocumentChange } from '../../../src/application/apply-document-change';
import { ConversationLog } from '../../../src/application/conversation-log';
import {
  RestoreConversation,
  StartNewConversation,
} from '../../../src/application/conversation-session';
import {
  ChangeNoLongerPendingError,
  EmptyRequestError,
  RequestInProgressError,
  RequestSupersededError,
} from '../../../src/application/errors';
import {
  HandleAssistantRequest,
  type RequestProgress,
} from '../../../src/application/handle-assistant-request';
import { PendingChanges, PendingDocumentChange } from '../../../src/application/pending-change';
import { RejectDocumentChange } from '../../../src/application/reject-document-change';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { ResolvedEdit } from '../../../src/domain/resolved-edit';
import { DocumentConflictError, InvariantViolation } from '../../../src/domain/errors';
import {
  AssistantProtocolError,
  AssistantTransportError,
  EditorUnavailableError,
} from '../../../src/ports/errors';
import {
  FakeAssistant,
  FakeEditor,
  InMemoryConversationRepository,
  sequentialIds,
} from '../../support/fakes';

const DOC = ['\\section{Intro}', 'Hello world.', '\\section{Results}', 'Numbers.'];

let editor: FakeEditor;
let assistant: FakeAssistant;
let repository: InMemoryConversationRepository;
let conversation: ConversationLog;
let pendingChanges: PendingChanges;
let handle: HandleAssistantRequest;
let apply: ApplyDocumentChange;
let reject: RejectDocumentChange;
let progress: RequestProgress[];

const send = (text: string) => handle.execute(text, (p) => progress.push(p));

const editReply = (overrides: Record<string, unknown> = {}) => ({
  kind: 'edit' as const,
  rationale: 'After results.',
  edit: ResolvedEdit.resolve(
    createDocumentSnapshot(DOC),
    createDocumentCommand({
      operation: 'insert_after',
      target: { lineNumber: 4, lineText: 'Numbers.' },
      content: 'More numbers.',
      reason: 'Adds detail.',
      ...overrides,
    }),
  ),
});

async function proposeEdit(overrides: Record<string, unknown> = {}) {
  assistant.willPlan({ intent: 'edit', needs: [] }).willReply(editReply(overrides));
  const result = await send('add more numbers');
  return result.changeId!;
}

beforeEach(() => {
  editor = new FakeEditor([...DOC]);
  assistant = new FakeAssistant();
  repository = new InMemoryConversationRepository();
  conversation = new ConversationLog(repository);
  pendingChanges = new PendingChanges();
  const newId = sequentialIds();
  handle = new HandleAssistantRequest({ assistant, editor, conversation, pendingChanges, newId });
  apply = new ApplyDocumentChange({ editor, pendingChanges });
  reject = new RejectDocumentChange({ editor, pendingChanges, conversation });
  progress = [];
});

describe('HandleAssistantRequest', () => {
  it('rejects an empty request', async () => {
    await expect(send('   ')).rejects.toThrow(EmptyRequestError);
    expect(conversation.messages()).toHaveLength(0);
  });

  it('answers greetings locally', async () => {
    const result = await send('Cześć!');
    expect(result.message).toMatchObject({ kind: 'greeting' });
    expect(assistant.planRequests).toHaveLength(0);
    expect(repository.stored.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('answers a summary with the document as evidence', async () => {
    assistant
      .willPlan({ intent: 'summary', needs: [] })
      .willReply({ kind: 'answer', text: 'A short paper.' });
    const result = await send('What is this document about?');
    expect(result.changeId).toBeUndefined();
    expect(result.message).toMatchObject({ kind: 'summary', text: 'A short paper.' });
    expect(assistant.replyRequests[0]!.evidence).toEqual({ document: editor.readDocument() });
    expect(progress.map((p) => p.stage)).toEqual(['received', 'planning', 'answering']);
  });

  it('answers an explanation with caret context, selection and logs', async () => {
    editor.cursorLine = 2;
    editor.selection = 'world';
    editor.logs = 'Undefined control sequence';
    assistant
      .willPlan({ intent: 'explain', needs: ['line_context', 'selection', 'logs'] })
      .willReply({ kind: 'answer', text: 'Because.' });
    const result = await send('why does this fail?');
    expect(result.message.kind).toBe('explanation');
    expect(assistant.replyRequests[0]!.evidence).toEqual({
      document: editor.readDocument(),
      lineContext: { firstLineNumber: 1, lines: DOC },
      selection: 'world',
      logs: 'Undefined control sequence',
    });
  });

  it('passes the conversation to the assistant', async () => {
    assistant.willPlan({ intent: 'explain', needs: [] }).willReply({ kind: 'answer', text: 'ok' });
    await send('hello');
    await send('second?');
    expect(assistant.planRequests[0]!.conversation).toMatchObject([
      { role: 'user', text: 'hello' },
      { role: 'assistant', kind: 'greeting' },
    ]);
  });

  it('proposes an edit as a previewed pending change', async () => {
    assistant.willPlan({ intent: 'edit', needs: [] }).willReply(editReply());
    const result = await send('add more numbers');
    const change = pendingChanges.get(result.changeId!);
    expect(result.message).toEqual({
      id: change.id,
      role: 'assistant',
      kind: 'proposal',
      command: change.edit.command,
      rationale: 'After results.',
    });
    expect(editor.preview).toBe(change.edit);
    expect(assistant.replyRequests[0]!.evidence.document).toEqual(editor.readDocument());
    expect(editor.applied).toHaveLength(0);
  });

  it('turns a question of the edit step into a clarification', async () => {
    assistant
      .willPlan({ intent: 'edit', needs: [] })
      .willReply({ kind: 'question', text: 'Which table?' });
    const result = await send('fix the table');
    expect(result.message).toMatchObject({
      role: 'assistant',
      kind: 'clarification',
      text: 'Which table?',
    });
    expect(result.message).not.toHaveProperty('proposal');
  });

  it('drops an edit when the document changed while the assistant was working', async () => {
    assistant.willPlan({ intent: 'edit', needs: [] }).willReply(editReply());
    const reply = assistant.reply.bind(assistant);
    assistant.reply = (request) => {
      editor.lines[0] = '\\section{Introduction}';
      return reply(request);
    };
    await expect(send('add more numbers')).rejects.toThrow(DocumentConflictError);
    expect(editor.preview).toBeNull();
    expect(conversation.messages().map((m) => m.role)).toEqual(['user']);
  });

  it('drops an edit whose preview fails', async () => {
    assistant.willPlan({ intent: 'edit', needs: [] }).willReply(editReply());
    editor.showPreview = () => {
      throw new EditorUnavailableError('gone');
    };
    await expect(send('add more numbers')).rejects.toThrow(EditorUnavailableError);
    expect(conversation.messages().map((m) => m.role)).toEqual(['user']);
  });

  it('treats an edit for a non-edit plan as a port contract violation', async () => {
    assistant.willPlan({ intent: 'explain', needs: [] }).willReply(editReply());
    await expect(send('explain')).rejects.toThrow(InvariantViolation);
  });

  it('propagates transport and protocol failures', async () => {
    assistant.willPlan(new AssistantTransportError('down'));
    await expect(send('summarize')).rejects.toThrow(AssistantTransportError);
    assistant
      .willPlan({ intent: 'summary', needs: [] })
      .willReply(new AssistantProtocolError('bad'));
    await expect(send('summarize')).rejects.toThrow(AssistantProtocolError);
  });

  it('requires the editor', async () => {
    editor.available = false;
    await expect(send('summarize')).rejects.toThrow(EditorUnavailableError);
    expect(assistant.planRequests).toHaveLength(0);
  });

  it('works on an empty document', async () => {
    editor.lines = [''];
    assistant
      .willPlan({ intent: 'explain', needs: [] })
      .willReply({ kind: 'answer', text: 'The document is empty.' });
    await expect(send('what is here?')).resolves.toMatchObject({
      message: { kind: 'explanation' },
    });
  });

  it('accepts one request at a time', async () => {
    assistant
      .willPlan({ intent: 'summary', needs: [] })
      .willReply({ kind: 'answer', text: 'A short paper.' });
    const first = send('What is this document about?');
    await expect(send('And the second one?')).rejects.toThrow(RequestInProgressError);
    await expect(first).resolves.toMatchObject({ message: { kind: 'summary' } });
  });

  it('discards the open change when a new request starts', async () => {
    const changeId = await proposeEdit();
    await send('hi');
    expect(editor.preview).toBeNull();
    expect(() => apply.execute(changeId)).toThrow(ChangeNoLongerPendingError);
    expect(() => reject.execute(changeId)).toThrow(ChangeNoLongerPendingError);
  });
});

describe('conversation reset during a request', () => {
  it('drops the late reply instead of adding it to the new conversation', async () => {
    let releasePlan: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });
    const slowAssistant = {
      plan: async () => {
        await gate;
        return { intent: 'edit' as const, needs: [] };
      },
      reply: () => Promise.resolve(editReply()),
    };
    const slowHandle = new HandleAssistantRequest({
      assistant: slowAssistant,
      editor,
      conversation,
      pendingChanges,
      newId: sequentialIds(),
    });
    const running = slowHandle.execute('add', () => undefined);
    new StartNewConversation({ conversation, pendingChanges, editor }).execute();
    releasePlan();
    await expect(running).rejects.toThrow(RequestSupersededError);
    expect(conversation.messages()).toHaveLength(0);
  });
});

describe('preview / apply / reject', () => {
  it('applies an approved command', async () => {
    const changeId = await proposeEdit();
    expect(apply.execute(changeId)).toBe(pendingChanges.get(changeId).edit.command);
    expect(editor.lines).toEqual([...DOC, 'More numbers.']);
    expect(editor.preview).toBeNull();
  });

  it('rejects a command and removes its proposal from the conversation', async () => {
    const changeId = await proposeEdit();
    const { removedMessageId } = reject.execute(changeId);
    expect(conversation.messages().some((m) => m.id === removedMessageId)).toBe(false);
    expect(repository.stored.some((m) => m.id === removedMessageId)).toBe(false);
    expect(editor.preview).toBeNull();
    expect(editor.lines).toEqual(DOC);
  });

  it('refuses a double apply', async () => {
    const changeId = await proposeEdit();
    apply.execute(changeId);
    expect(() => apply.execute(changeId)).toThrow(ChangeNoLongerPendingError);
    expect(editor.applied).toHaveLength(1);
  });

  it('refuses apply after reject and reject after apply', async () => {
    const first = await proposeEdit();
    reject.execute(first);
    expect(() => apply.execute(first)).toThrow('it was rejected');
    const second = await proposeEdit();
    apply.execute(second);
    expect(() => reject.execute(second)).toThrow(ChangeNoLongerPendingError);
  });

  it('treats approving a change that was never previewed as a defect', () => {
    const change = new PendingDocumentChange('c', editReply().edit);
    expect(() => {
      change.approve();
    }).toThrow(InvariantViolation);
  });

  it('detects a document changed between preview and apply', async () => {
    const changeId = await proposeEdit();
    editor.lines[0] = '\\section{Introduction}';
    expect(() => apply.execute(changeId)).toThrow(DocumentConflictError);
    expect(editor.applied).toHaveLength(0);
    expect(() => apply.execute(changeId)).toThrow(ChangeNoLongerPendingError);
  });

  it('detects a stale target', async () => {
    const changeId = await proposeEdit();
    editor.lines[3] = 'Numbers changed.';
    expect(() => apply.execute(changeId)).toThrow(DocumentConflictError);
  });

  it('detects a target that disappeared', async () => {
    const changeId = await proposeEdit();
    editor.lines.pop();
    expect(() => apply.execute(changeId)).toThrow(DocumentConflictError);
    expect(() => apply.execute(changeId)).toThrow('it was failed');
  });

  it('fails when the editor vanished before apply', async () => {
    const changeId = await proposeEdit();
    editor.available = false;
    expect(() => apply.execute(changeId)).toThrow(EditorUnavailableError);
    expect(() => apply.execute(changeId)).toThrow('it was failed');
  });
});

describe('conversation', () => {
  it('restores and starts a new conversation', async () => {
    repository.stored = [{ id: 'a', role: 'user', text: 'old' }];
    expect(new RestoreConversation({ conversation }).execute()).toHaveLength(1);
    const change = pendingChanges.get(await proposeEdit());
    new StartNewConversation({ conversation, pendingChanges, editor }).execute();
    expect(conversation.messages()).toHaveLength(0);
    expect(repository.stored).toHaveLength(0);
    expect(() => apply.execute(change.id)).toThrow(ChangeNoLongerPendingError);
  });

  it('keeps working when storage fails and reports it once', async () => {
    repository.failing = true;
    const result = await send('hello');
    expect(result.message.kind).toBe('greeting');
    expect(conversation.messages()).toHaveLength(2);
    expect(conversation.takePersistenceFailure()?.message).toBe('storage off');
    expect(conversation.takePersistenceFailure()).toBeNull();
  });

  it('keeps only the last 80 messages', async () => {
    for (let i = 0; i < 45; i += 1) await send('hi');
    expect(repository.stored).toHaveLength(80);
  });
});
