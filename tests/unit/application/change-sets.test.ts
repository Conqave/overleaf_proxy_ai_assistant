import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChangeNoLongerPendingError,
  NothingToUndoError,
  UndecidedEditsError,
  RequestInProgressError,
  RequestSupersededError,
} from '../../../src/application/errors';
import { answer } from '../../support/decisions';
import { MAX_EDITS_PER_CHANGE, type EditRequest } from '../../../src/domain/change-set';
import type { CompileDiagnostic } from '../../../src/domain/agent-transcript';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { DocumentConflictError } from '../../../src/domain/errors';
import {
  EditorShowsOtherFileError,
  EditorUnavailableError,
  FileOpenTimeoutError,
  SessionStorageError,
} from '../../../src/ports/errors';
import { PendingStep, rejectOnAbort } from '../../support/fakes';
import { anInstanceOf, itemAt, objectContaining, textContaining } from '../../support/guards';
import { TestFixtureError } from '../../support/test-errors';
import { UseCaseWorld, MAIN, BIB, editsOf, bibEdit, readBib } from '../../support/use-case-world';

let world: UseCaseWorld;

beforeEach(() => {
  world = new UseCaseWorld();
});

describe('preview / apply / reject', () => {
  const latest = () => world.conversation.messages().findLast(({ role }) => role !== 'notice');

  it('applies an approved change and then compiles the project', async () => {
    world.project.willCompile([]);
    const changeId = await world.proposeEdit();
    world.progress = [];
    const outcome = await world.apply.execute(changeId, null, world.record);
    expect(world.editor.lines).toEqual([...MAIN, 'Added.']);
    expect(world.editor.preview).toBeNull();
    const applied = latest();
    expect(outcome).toEqual({ message: applied, review: { kind: 'compiled' } });
    expect(applied).toMatchObject({
      id: changeId,
      kind: 'proposal',
      edits: [
        {
          path: 'main.tex',
          status: 'applied',
          applied: { line: 5, before: [], after: ['Added.'], sequence: 0 },
        },
      ],
    });
    expect(world.storedMessages().at(-3)).toEqual(applied);
    const noticed = (notice: unknown) => ({
      stage: 'noted',
      message: { id: anInstanceOf(String), role: 'notice', notice },
    });
    expect(world.progress).toEqual([
      { stage: 'decided', message: applied },
      noticed({
        kind: 'applied',
        applied: [{ path: 'main.tex', command: objectContaining({ content: 'Added.' }) }],
      }),
      { stage: 'compiling' },
      noticed({ kind: 'compiled', errorCount: 0 }),
    ]);
    expect(world.storedMessages().slice(-2)).toEqual(
      world.progress.flatMap((p) => (p.stage === 'noted' ? [p.message] : [])),
    );
  });

  it('cancels the review compile of an applied change for a new conversation', async () => {
    const changeId = await world.proposeEdit();
    world.project.willCompile(new PendingStep(rejectOnAbort));
    const applying = world.apply.execute(changeId, null, world.record);
    await vi.waitFor(() => {
      expect(world.project.compileCalls).toBe(1);
    });
    const reset = world.startNew();
    await expect(applying).rejects.toThrow(RequestSupersededError);
    await reset;
    expect(world.editor.lines).toEqual([...MAIN, 'Added.']);
    expect(world.isBusy()).toBe(false);
  });

  it('cancels a file read of the agent for a new conversation', async () => {
    world.agent.will(readBib());
    world.project.holdsReads = true;
    const running = world.send('read the bibliography');
    await vi.waitFor(() => {
      expect(world.project.reads).toEqual(['refs.bib']);
    });
    const reset = world.startNew();
    await expect(running).rejects.toThrow(RequestSupersededError);
    await reset;
  });

  it('refuses a request while an applied change is being reviewed', async () => {
    const changeId = await world.proposeEdit();
    const compiled = Promise.withResolvers<readonly CompileDiagnostic[]>();
    world.project.willCompile(new PendingStep(() => compiled.promise));
    const applying = world.apply.execute(changeId, null, world.record);
    expect(world.isBusy()).toBe(true);
    await expect(world.send('what next?')).rejects.toThrow(RequestInProgressError);
    compiled.resolve([]);
    await expect(applying).resolves.toMatchObject({ review: { kind: 'compiled' } });
    expect(world.isBusy()).toBe(false);
  });

  it('opens the file of the change when the user switched away before Apply', async () => {
    world.project.willCompile([]);
    const changeId = await world.proposeEdit(readBib(), bibEdit());
    world.project.switchTo('main.tex');
    world.progress = [];
    await world.apply.execute(changeId, null, world.record);
    expect(world.project.opened).toEqual(['refs.bib', 'refs.bib']);
    expect(world.progress[0]).toEqual({ stage: 'opening', path: 'refs.bib' });
    expect(world.editor.lines).toEqual([...BIB, 'Added.']);
  });

  it('keeps the change for another Apply when its file cannot be opened', async () => {
    world.project.willCompile([]);
    const changeId = await world.proposeEdit(readBib(), bibEdit());
    world.project.switchTo('main.tex');
    world.project.failure.openFile = new FileOpenTimeoutError('slow');
    await expect(world.apply.execute(changeId, null, world.record)).rejects.toThrow(
      FileOpenTimeoutError,
    );
    expect(world.editor.applied).toHaveLength(0);
    expect(latest()).toMatchObject({ id: changeId, edits: [{ status: 'proposed' }] });
    world.project.failure = {};
    await expect(world.apply.execute(changeId, null, world.record)).resolves.toMatchObject({
      review: { kind: 'compiled' },
    });
    expect(world.editor.lines).toEqual([...BIB, 'Added.']);
  });

  it('keeps the change for another Apply when the editor vanished before the write', async () => {
    const changeId = await world.proposeEdit();
    world.editor.available = false;
    await expect(world.apply.execute(changeId, null, world.record)).rejects.toThrow(
      EditorUnavailableError,
    );
    expect(world.progress.filter((p) => p.stage === 'decided')).toEqual([]);
    expect(world.pendingChanges.isPending(changeId)).toBe(true);
    world.editor.available = true;
    await expect(world.reject.execute(changeId, null, world.record)).resolves.toMatchObject({
      message: { edits: [{ status: 'rejected' }] },
      review: null,
    });
  });

  it('records a change whose write failed as failed', async () => {
    const changeId = await world.proposeEdit();
    world.progress = [];
    world.editor.applyFailure = new EditorShowsOtherFileError('switched');
    await expect(world.apply.execute(changeId, null, world.record)).rejects.toThrow(
      EditorShowsOtherFileError,
    );
    const failed = { id: changeId, kind: 'proposal', edits: [{ status: 'failed' }] };
    expect(world.progress).toEqual([{ stage: 'decided', message: latest() }]);
    expect(latest()).toMatchObject(failed);
    expect(world.storedMessages().slice(-2)).toMatchObject([
      failed,
      { role: 'notice', notice: { kind: 'failed', problem: 'switched' } },
    ]);
    await expect(world.apply.execute(changeId, null, world.record)).rejects.toThrow(
      ChangeNoLongerPendingError,
    );
  });

  it('keeps the failure of the write when recording it fails as well', async () => {
    const changeId = await world.proposeEdit();
    const writeFailure = new EditorShowsOtherFileError('switched');
    world.editor.applyFailure = writeFailure;
    const recordingFailure = new SessionStorageError('full');
    vi.spyOn(world.conversation, 'updateProposal').mockImplementation(() => {
      throw recordingFailure;
    });
    await expect(world.apply.execute(changeId, null, world.record)).rejects.toMatchObject({
      name: 'FailureRecordingError',
      failure: writeFailure,
      cause: recordingFailure,
    });
  });

  it('leaves a change discarded by a new conversation during Apply discarded', async () => {
    const changeId = await world.proposeEdit(readBib(), bibEdit());
    world.project.switchTo('main.tex');
    world.project.onOpen = () => {
      world.resetLater();
    };
    await expect(world.apply.execute(changeId, null, world.record)).rejects.toThrow(
      RequestSupersededError,
    );
    await Promise.all(world.resets);
    expect(world.editor.applied).toHaveLength(0);
    expect(world.pendingChanges.isPending(changeId)).toBe(false);
  });

  it('rejects a change and keeps its proposal in the conversation as rejected', async () => {
    const changeId = await world.proposeEdit();
    const { message, review } = await world.reject.execute(changeId, null, world.record);
    expect(message).toMatchObject({
      id: changeId,
      kind: 'proposal',
      edits: [{ status: 'rejected' }],
    });
    expect(review).toBeNull();
    expect(latest()).toEqual(message);
    expect(world.storedMessages().at(-1)).toEqual(message);
    expect(world.editor.preview).toBeNull();
    expect(world.editor.lines).toEqual(MAIN);
    expect(world.project.compileCalls).toBe(0);
  });

  it('refuses a double apply', async () => {
    world.project.willCompile([]);
    const changeId = await world.proposeEdit();
    await world.apply.execute(changeId, null, world.record);
    await expect(world.apply.execute(changeId, null, world.record)).rejects.toThrow(
      ChangeNoLongerPendingError,
    );
    expect(world.editor.applied).toHaveLength(1);
  });

  it('refuses apply after reject and reject after apply', async () => {
    world.project.willCompile([]);
    const first = await world.proposeEdit();
    await world.reject.execute(first, null, world.record);
    await expect(world.apply.execute(first, null, world.record)).rejects.toThrow(
      ChangeNoLongerPendingError,
    );
    const second = await world.proposeEdit();
    await world.apply.execute(second, null, world.record);
    await expect(world.reject.execute(second, null, world.record)).rejects.toThrow(
      ChangeNoLongerPendingError,
    );
  });

  it('refuses to reject a change while it is being applied', async () => {
    const changeId = await world.proposeEdit();
    const compiled = Promise.withResolvers<readonly CompileDiagnostic[]>();
    world.project.willCompile(new PendingStep(() => compiled.promise));
    const applying = world.apply.execute(changeId, null, world.record);
    await expect(world.reject.execute(changeId, null, world.record)).rejects.toThrow(
      RequestInProgressError,
    );
    compiled.resolve([]);
    await expect(applying).resolves.toMatchObject({ review: { kind: 'compiled' } });
  });

  it('discards open changes and their preview in one step for a request and for a new session', async () => {
    const first = await world.proposeEdit();
    expect(world.editor.preview).not.toBeNull();
    world.agent.will(answer('Something else.'));
    world.progress = [];
    await world.send('never mind');
    expect(world.editor.preview).toBeNull();
    expect(world.progress).toContainEqual({
      stage: 'decided',
      message: objectContaining({ id: first, edits: [objectContaining({ status: 'discarded' })] }),
    });
    const second = await world.proposeEdit();
    expect(world.editor.preview).not.toBeNull();
    await world.startNew();
    expect(world.editor.preview).toBeNull();
    expect(world.pendingChanges.isPending(second)).toBe(false);
  });

  it('forgets closed changes at once', async () => {
    world.project.willCompile([]);
    const applied = await world.proposeEdit();
    await world.apply.execute(applied, null, world.record);
    const rejected = await world.proposeEdit();
    await world.reject.execute(rejected, null, world.record);
    expect(world.pendingChanges.isPending(applied)).toBe(false);
    expect(world.pendingChanges.isPending(rejected)).toBe(false);
    expect(world.pendingChanges.discardAll()).toEqual([]);
  });

  it.each([
    [
      'a document changed between preview and apply',
      () => {
        world.editor.lines[0] = '\\section{Introduction}';
      },
    ],
    [
      'a target that disappeared',
      () => {
        world.editor.lines.pop();
      },
    ],
  ])('records %s as a conflict and applies nothing', async (_name, interfere) => {
    const changeId = await world.proposeEdit();
    interfere();
    world.progress = [];
    const outcome = await world.apply.execute(changeId, null, world.record);
    expect(outcome).toEqual({ message: latest(), review: null });
    expect(latest()).toMatchObject({ id: changeId, edits: [{ status: 'failed' }] });
    expect(world.editor.applied).toHaveLength(0);
    expect(world.progress).toContainEqual({
      stage: 'noted',
      message: objectContaining({
        notice: {
          kind: 'conflict',
          path: 'main.tex',
          problem:
            'The document changed after the suggestion was made. Ask again to get a fresh suggestion.',
        },
      }),
    });
    expect(world.progress.map(({ stage }) => stage)).not.toContain('compiling');
    await expect(world.apply.execute(changeId, null, world.record)).rejects.toThrow(
      ChangeNoLongerPendingError,
    );
  });
});

describe('change sets', () => {
  const request = (
    path: string,
    lines: readonly string[],
    operation: 'insert_after' | 'replace',
    lineNumber: number,
    content: string,
  ): EditRequest => ({
    path,
    command: createDocumentCommand({
      operation,
      target: { lineNumber, lineText: itemAt(lines, lineNumber - 1, 'line') },
      content,
    }),
  });
  const addIntro = request('main.tex', MAIN, 'insert_after', 2, 'Intro detail.');
  const changeNumbers = request('main.tex', MAIN, 'replace', 4, 'Numbers changed.');
  const addBook = request('refs.bib', BIB, 'insert_after', 3, '@book{knuth84}');
  const EDITED_MAIN = [
    '\\section{Intro}',
    'Hello world.',
    'Intro detail.',
    '\\section{Results}',
    'Numbers changed.',
  ];
  const latest = () => world.conversation.messages().findLast(({ role }) => role !== 'notice');
  const proposeBatch = () =>
    world.proposeEdit(readBib(), editsOf(addIntro, changeNumbers, addBook));
  const statuses = () => {
    const message = world.conversation
      .messages()
      .findLast((shown) => shown.role === 'assistant' && shown.kind === 'proposal');
    if (message === undefined) throw new TestFixtureError('the conversation has no proposal');
    return message.edits.map(({ status }) => status);
  };
  const editBib = (line: string) => {
    world.project.switchTo('refs.bib');
    world.editor.lines[0] = line;
    world.project.switchTo('main.tex');
  };

  it('proposes the edits of several files as one change and previews the first file', async () => {
    const changeId = await proposeBatch();
    expect(latest()).toEqual({
      id: changeId,
      role: 'assistant',
      kind: 'proposal',
      edits: [addIntro, changeNumbers, addBook].map((edit) => ({ ...edit, status: 'proposed' })),
    });
    expect(world.editor.preview?.map(({ command }) => command)).toMatchObject([
      { content: 'Intro detail.' },
      { content: 'Numbers changed.' },
    ]);
    expect(world.project.opened).toEqual([]);
  });

  it('applies every file at once, bottom-up, and compiles once', async () => {
    world.project.willCompile([]);
    const changeId = await proposeBatch();
    const outcome = await world.apply.execute(changeId, null, world.record);
    expect(world.project.savedDocument('main.tex')).toEqual(EDITED_MAIN);
    expect(world.editor.lines).toEqual([...BIB, '@book{knuth84}']);
    expect(statuses()).toEqual(['applied', 'applied', 'applied']);
    expect(latest()).toMatchObject({
      edits: [
        { applied: { line: 3, sequence: 1 } },
        { applied: { line: 4, before: ['Numbers \\cite{knuth84}.'], sequence: 0 } },
        { applied: { line: 4, sequence: 2 } },
      ],
    });
    expect(outcome.review).toEqual({ kind: 'compiled' });
    expect(world.project.compileCalls).toBe(1);
    expect(world.editor.applied).toHaveLength(2);
  });

  it('applies single edits, moves the open ones and compiles after the last decision', async () => {
    world.project.willCompile([]);
    const changeId = await proposeBatch();
    await expect(world.apply.execute(changeId, [0], world.record)).resolves.toMatchObject({
      review: null,
    });
    expect(world.editor.lines).toEqual([...MAIN.slice(0, 2), 'Intro detail.', ...MAIN.slice(2)]);
    expect(world.editor.preview?.map(({ command }) => command.target.lineNumber)).toEqual([5]);
    expect(statuses()).toEqual(['applied', 'proposed', 'proposed']);
    await world.apply.execute(changeId, [1], world.record);
    expect(world.editor.lines).toEqual(EDITED_MAIN);
    expect(world.project.compileCalls).toBe(0);
    const outcome = await world.reject.execute(changeId, [2], world.record);
    expect(statuses()).toEqual(['applied', 'applied', 'rejected']);
    expect(outcome.review).toEqual({ kind: 'compiled' });
    expect(world.project.compileCalls).toBe(1);
    expect(world.editor.preview).toBeNull();
  });

  it('fails only the edits of a file that changed and applies the others', async () => {
    world.project.willCompile([]);
    const changeId = await proposeBatch();
    editBib('@misc{changed,');
    world.progress = [];
    const outcome = await world.apply.execute(changeId, null, world.record);
    expect(statuses()).toEqual(['applied', 'applied', 'failed']);
    expect(world.project.savedDocument('main.tex')).toEqual(EDITED_MAIN);
    expect(world.editor.lines[0]).toBe('@misc{changed,');
    expect(world.progress.flatMap((p) => (p.stage === 'noted' ? [p.message.notice] : []))).toEqual([
      {
        kind: 'applied',
        applied: [
          { path: 'main.tex', command: addIntro.command },
          { path: 'main.tex', command: changeNumbers.command },
        ],
      },
      { kind: 'conflict', path: 'refs.bib', problem: textContaining('document changed') },
      { kind: 'compiled', errorCount: 0 },
    ]);
    expect(outcome.review).toEqual({ kind: 'compiled' });
  });

  it('previews the open edits of another file on demand', async () => {
    const changeId = await proposeBatch();
    world.progress = [];
    await world.preview.execute(changeId, 'refs.bib', world.record);
    expect(world.project.opened).toEqual(['refs.bib']);
    expect(world.progress).toEqual([{ stage: 'opening', path: 'refs.bib' }]);
    expect(world.editor.preview?.map(({ command }) => command)).toMatchObject([
      { content: '@book{knuth84}' },
    ]);
    expect(statuses()).toEqual(['proposed', 'proposed', 'proposed']);
  });

  it('refuses to preview a file that changed or has no open edits', async () => {
    const changeId = await proposeBatch();
    editBib('@misc{changed,');
    await expect(world.preview.execute(changeId, 'refs.bib', world.record)).rejects.toThrow(
      DocumentConflictError,
    );
    await world.reject.execute(changeId, [2], world.record);
    await expect(world.preview.execute(changeId, 'refs.bib', world.record)).rejects.toThrow(
      ChangeNoLongerPendingError,
    );
    expect(statuses()).toEqual(['proposed', 'proposed', 'rejected']);
  });

  it('undoes every applied edit of a turn per file and tells the model', async () => {
    world.project.willCompile([]);
    const changeId = await proposeBatch();
    await world.apply.execute(changeId, null, world.record);
    world.progress = [];
    world.project.willCompile([]);
    const { message, notice } = await world.undo.execute(changeId, world.record);
    expect(world.project.compileCalls).toBe(2);
    expect(world.progress.at(-1)).toEqual({
      stage: 'noted',
      message: {
        id: anInstanceOf(String),
        role: 'notice',
        notice: { kind: 'compiled', errorCount: 0 },
      },
    });
    expect(world.project.savedDocument('main.tex')).toEqual(MAIN);
    expect(world.editor.lines).toEqual(BIB);
    expect(statuses()).toEqual(['undone', 'undone', 'undone']);
    expect(message).toEqual(world.conversation.findProposal(changeId));
    expect(notice).toEqual({
      id: notice.id,
      role: 'undo',
      proposalId: changeId,
      undone: ['main.tex', 'refs.bib'],
      refused: [],
    });
    expect(world.storedMessages().at(-2)).toEqual(notice);
    expect(world.progress.filter(({ stage }) => stage === 'decided')).toHaveLength(2);
    world.agent.will(answer('Noted.'));
    await world.send('what happened?');
    expect(world.requestAt(-1).conversation.messages).toContainEqual(notice);
    await expect(world.undo.execute(changeId, world.record)).rejects.toThrow(NothingToUndoError);
  });

  it('undoes edits applied one by one, the later ones first', async () => {
    world.project.willCompile([]);
    const changeId = await proposeBatch();
    await world.apply.execute(changeId, [1], world.record);
    await world.apply.execute(changeId, [0], world.record);
    await world.reject.execute(changeId, [2], world.record);
    world.project.willCompile([]);
    await world.undo.execute(changeId, world.record);
    expect(world.editor.lines).toEqual(MAIN);
    expect(statuses()).toEqual(['undone', 'undone', 'rejected']);
  });

  it('refuses to undo a file whose written text changed and undoes the others', async () => {
    world.project.willCompile([]);
    const changeId = await proposeBatch();
    await world.apply.execute(changeId, null, world.record);
    world.editor.lines[3] = '@book{knuth84, edited}';
    world.project.willCompile([]);
    const { notice } = await world.undo.execute(changeId, world.record);
    expect(notice.undone).toEqual(['main.tex']);
    expect(notice.refused).toEqual([
      {
        path: 'refs.bib',
        problem:
          'refs.bib changed after Hans edited it: line 4 no longer holds the text Hans wrote there, so this file was left as it is.',
      },
    ]);
    expect(world.editor.lines).toEqual([...BIB, '@book{knuth84, edited}']);
    expect(world.project.savedDocument('main.tex')).toEqual(MAIN);
    expect(statuses()).toEqual(['undone', 'undone', 'applied']);
  });

  it('compiles nothing when every file of the undo was refused', async () => {
    world.project.willCompile([]);
    const changeId = await world.proposeEdit(readBib(), bibEdit());
    await world.apply.execute(changeId, null, world.record);
    world.editor.lines[3] = 'changed by hand';
    const { notice } = await world.undo.execute(changeId, world.record);
    expect(notice.undone).toEqual([]);
    expect(world.conversation.messages().at(-1)).toEqual(notice);
    expect(world.project.compileCalls).toBe(1);
  });

  it('refuses to undo a turn with open edits or nothing applied', async () => {
    world.project.willCompile([]);
    const changeId = await proposeBatch();
    await expect(world.undo.execute(changeId, world.record)).rejects.toThrow(UndecidedEditsError);
    await world.apply.execute(changeId, [0], world.record);
    await expect(world.undo.execute(changeId, world.record)).rejects.toThrow(UndecidedEditsError);
    const rejected = await world.proposeEdit(readBib(), bibEdit());
    await world.reject.execute(rejected, null, world.record);
    await expect(world.undo.execute(rejected, world.record)).rejects.toThrow(NothingToUndoError);
    expect(world.editor.applied).toHaveLength(1);
  });

  it('undoes under the operation lock and records what it did before a failure', async () => {
    world.project.willCompile([]);
    const changeId = await proposeBatch();
    await world.apply.execute(changeId, null, world.record);
    world.project.onOpen = (path) => {
      if (path === 'main.tex') world.project.failure.openFile = new FileOpenTimeoutError('slow');
    };
    const undoing = world.undo.execute(changeId, world.record);
    expect(world.isBusy()).toBe(true);
    await expect(undoing).rejects.toThrow(FileOpenTimeoutError);
    expect(world.conversation.messages().slice(-2)).toMatchObject([
      { role: 'undo', undone: ['main.tex'], refused: [] },
      { role: 'notice', notice: { kind: 'failed', problem: 'slow' } },
    ]);
    expect(world.editor.lines).toEqual(MAIN);
    expect(world.isBusy()).toBe(false);
  });

  it('records a cancelled undo in the session it left before a new conversation starts', async () => {
    world.project.willCompile([]);
    const changeId = await proposeBatch();
    await world.apply.execute(changeId, null, world.record);
    const sessionId = world.conversation.sessionId;
    if (sessionId === null) throw new TestFixtureError('the change was proposed outside a session');
    world.project.onOpen = (path) => {
      if (path === 'refs.bib') world.resetLater();
    };
    await expect(world.undo.execute(changeId, world.record)).rejects.toThrow(
      RequestSupersededError,
    );
    await Promise.all(world.resets);
    expect(world.repository.stored.get(sessionId)?.messages.slice(-2)).toMatchObject([
      { role: 'undo', undone: ['main.tex'], refused: [] },
      { role: 'notice', notice: { kind: 'cancelled' } },
    ]);
    expect(world.conversation.sessionId).toBeNull();
    expect(world.isBusy()).toBe(false);
  });

  it('keeps the failure of an undo when recording what it did fails as well', async () => {
    world.project.willCompile([]);
    const changeId = await proposeBatch();
    await world.apply.execute(changeId, null, world.record);
    const openFailure = new FileOpenTimeoutError('slow');
    world.project.onOpen = (path) => {
      if (path === 'main.tex') world.project.failure.openFile = openFailure;
    };
    const recordingFailure = new SessionStorageError('full');
    vi.spyOn(world.conversation, 'append').mockImplementation(() => {
      throw recordingFailure;
    });
    await expect(world.undo.execute(changeId, world.record)).rejects.toMatchObject({
      name: 'FailureRecordingError',
      failure: openFailure,
      cause: recordingFailure,
    });
    expect(world.isBusy()).toBe(false);
  });

  it('sends overlapping edits back to the agent', async () => {
    const twice = request('main.tex', MAIN, 'replace', 4, 'Other numbers.');
    world.agent.will(editsOf(changeNumbers, twice), answer('Fixed.'));
    await world.send('change the numbers');
    expect(world.requestAt(1).transcript).toEqual([
      {
        kind: 'mistake',
        decision: editsOf(changeNumbers, twice),
        problem:
          'edits 1 and 2 both change main.tex at or next to line 4; send one edit for those lines instead of two',
      },
    ]);
  });

  it('sends a change with too many edits back to the agent once', async () => {
    const many = Array.from({ length: MAX_EDITS_PER_CHANGE + 1 }, () => addIntro);
    world.agent.will(editsOf(...many), answer('Fewer then.'));
    await world.send('change everything');
    expect(world.requestAt(1).transcript).toEqual([
      {
        kind: 'mistake',
        decision: editsOf(...many),
        problem: `one change carries at most ${String(MAX_EDITS_PER_CHANGE)} edits, but this one has ${String(MAX_EDITS_PER_CHANGE + 1)}; merge changes of neighbouring lines into one replacement of their line range, or leave the rest for a later request`,
      },
    ]);
  });

  it('names the edit of a change that the agent got wrong', async () => {
    world.agent.will(editsOf(addIntro, addBook), answer('Fixed.'));
    await world.send('update both');
    expect(world.requestAt(1).transcript[0]).toMatchObject({
      kind: 'mistake',
      problem:
        'edit 2 of 2 (refs.bib): refs.bib must be read with read_file before it can be edited',
    });
  });
});
