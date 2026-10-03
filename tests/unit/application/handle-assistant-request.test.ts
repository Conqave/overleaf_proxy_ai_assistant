import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentMistakeLimitError,
  ChangeNoLongerPendingError,
  EmptyRequestError,
  RequestInProgressError,
  RequestSupersededError,
} from '../../../src/application/errors';
import { PARALLEL_SEARCH_READS } from '../../../src/application/project-tools';
import { ReadContextUsage } from '../../../src/application/read-context-usage';
import type { AgentDecision } from '../../../src/domain/agent-action';
import { answer, tool } from '../../support/decisions';
import { MAIN_AGENT_POLICY } from '../../support/policies';
import { createDocumentSnapshot, type DocumentSnapshot } from '../../../src/domain/document';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { DocumentConflictError } from '../../../src/domain/errors';
import {
  AssistantProtocolError,
  AssistantUnreachableError,
  CompileTimeoutError,
  EditorShowsOtherFileError,
  EditorUnavailableError,
  FileOpenTimeoutError,
  ProjectFileReadError,
  ProjectUnavailableError,
} from '../../../src/ports/errors';
import {
  EMPTY_CONVERSATION,
  FAKE_CONTEXT_TOKENS,
  FakeProject,
  PendingStep,
  rejectOnAbort,
  storedSession,
} from '../../support/fakes';
import { anInstanceOf, itemAt, objectContaining, textContaining } from '../../support/guards';
import {
  UseCaseWorld,
  MAIN,
  BIB,
  editOf,
  insertionOf,
  editAt,
  editsOf,
  mainEdit,
  bibEdit,
  readBib,
  changeIdOf,
} from '../../support/use-case-world';

let world: UseCaseWorld;

beforeEach(() => {
  world = new UseCaseWorld();
});

describe('HandleAssistantRequest', () => {
  it('rejects an empty request', async () => {
    await expect(world.send('   ')).rejects.toThrow(EmptyRequestError);
    expect(world.conversation.messages()).toHaveLength(0);
  });

  it('sends a greeting to the agent like any other message', async () => {
    world.agent.will(answer('Hi! What should I change?'));
    const result = await world.send('Cześć!');
    expect(result.message).toMatchObject({ kind: 'explanation' });
    expect(world.requestAt(0).request).toMatchObject({ message: { role: 'user', text: 'Cześć!' } });
    expect(world.storedMessages().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('answers without tools and shows the agent the whole workspace', async () => {
    world.editor.cursorLine = 2;
    world.editor.selection = 'world';
    world.agent.will(answer('A short paper.'));
    const result = await world.send('What is this document about?');
    expect(result.kind).toBe('reply');
    expect(result.message).toMatchObject({ kind: 'explanation', text: 'A short paper.' });
    expect(world.agent.requests[0]).toEqual({
      request: {
        kind: 'user',
        message: { id: anInstanceOf(String), role: 'user', text: 'What is this document about?' },
      },
      policy: MAIN_AGENT_POLICY,
      conversation: EMPTY_CONVERSATION,
      workspace: {
        files: world.project.files,
        openFile: {
          kind: 'text',
          path: 'main.tex',
          document: createDocumentSnapshot(MAIN),
          cursorLine: 2,
          selection: 'world',
        },
      },
      transcript: [],
      signal: anInstanceOf(AbortSignal),
    });
    expect(world.progress.map((p) => p.stage)).toEqual(['received', 'thinking', 'measured']);
  });

  it('works without an open file while Overleaf shows a binary file', async () => {
    world.project.showBinaryFile('figures/plot.png');
    world.agent.will(tool({ tool: 'read_file', path: 'main.tex' }), mainEdit());
    const result = await world.send('In main.tex, add a sentence.');
    expect(world.requestAt(0).workspace).toEqual({
      files: world.project.files,
      openFile: { kind: 'binary', path: 'figures/plot.png' },
    });
    expect(result.kind).toBe('proposal');
    expect(world.project.opened).toEqual(['main.tex']);
    expect(world.editor.preview).toHaveLength(1);
  });

  it('keeps the file the user opened instead of the binary file of the request', async () => {
    world.project.showBinaryFile('figures/plot.png');
    world.agent.onDecide = () => {
      world.project.switchTo('refs.bib');
    };
    world.agent.will(tool({ tool: 'read_file', path: 'main.tex' }), mainEdit());
    const result = await world.send('In main.tex, add a sentence.');
    expect(world.project.opened).toEqual([]);
    expect(world.project.shownFile().path).toBe('refs.bib');
    expect(result).toMatchObject({ kind: 'proposal', previewShown: false });
  });

  it('reports the context usage of the decision that ended the request', async () => {
    world.agent.will(tool({ tool: 'compile' }), answer('It compiles.'));
    world.project.willCompile([]);
    const result = await world.send('does it compile?');
    expect(result).toHaveProperty('contextUsage', {
      contextTokens: FAKE_CONTEXT_TOKENS,
      promptTokens: 2_000,
      pressure: 'low',
    });
  });

  it('passes the conversation to the agent', async () => {
    world.agent.will(answer('ok'), answer('fine'));
    await world.send('hello');
    await world.send('second?');
    expect(world.requestAt(1).conversation.messages).toMatchObject([
      { role: 'user', text: 'hello' },
      { role: 'assistant', kind: 'explanation', text: 'ok' },
    ]);
  });

  it('turns a question into a clarification', async () => {
    world.agent.will({ kind: 'reply', reply: { kind: 'question', text: 'Which table?' } });
    const result = await world.send('fix the table');
    expect(result.message).toMatchObject({ kind: 'clarification', text: 'Which table?' });
  });

  it('proposes an edit of the open file as a previewed pending change', async () => {
    world.agent.will(mainEdit());
    const result = await world.send('add more');
    expect(result.message).toEqual({
      id: changeIdOf(result),
      role: 'assistant',
      kind: 'proposal',
      edits: [
        { path: 'main.tex', command: world.editor.preview?.[0]?.command, status: 'proposed' },
      ],
    });
    expect(world.pendingChanges.isPending(changeIdOf(result))).toBe(true);
    expect(world.project.opened).toEqual([]);
    expect(world.editor.applied).toHaveLength(0);
  });

  it('reads another file, then opens it before previewing its edit', async () => {
    world.agent.will(tool({ tool: 'read_file', path: 'refs.bib' }), bibEdit());
    const result = await world.send('add knuth84 to the bibliography');
    expect(world.requestAt(1).transcript).toEqual([
      {
        kind: 'tool',
        call: { tool: 'read_file', path: 'refs.bib' },
        result: {
          tool: 'read_file',
          path: 'refs.bib',
          document: createDocumentSnapshot(BIB),
          shown: { first: 1, last: BIB.length },
        },
      },
    ]);
    expect(world.project.opened).toEqual(['refs.bib']);
    expect(result.message).toMatchObject({ kind: 'proposal', edits: [{ path: 'refs.bib' }] });
    expect(result.message).toHaveProperty('edits.0.command', world.editor.preview?.[0]?.command);
    expect(world.progress).toEqual([
      expect.objectContaining({ stage: 'received' }),
      { stage: 'thinking', step: 1 },
      expect.objectContaining({ stage: 'measured' }),
      { stage: 'reading', path: 'refs.bib' },
      {
        stage: 'recorded',
        message: objectContaining({ role: 'tool', record: objectContaining({ path: 'refs.bib' }) }),
      },
      { stage: 'thinking', step: 2 },
      expect.objectContaining({ stage: 'measured' }),
      { stage: 'opening', path: 'refs.bib' },
    ]);
  });

  it('edits a long file only in the lines a ranged read showed', async () => {
    const long = Array.from({ length: 3_000 }, (_, index) => `Line ${String(index + 1)}.`);
    world.project = new FakeProject(
      world.editor,
      { 'main.tex': MAIN, 'long.tex': long },
      'main.tex',
    );
    world.wireRequests();
    world.agent.will(
      tool({ tool: 'read_file', path: 'long.tex' }),
      editOf('long.tex', long, 2_500),
      tool({ tool: 'read_file', path: 'long.tex', range: { startLine: 2_400, endLine: 2_600 } }),
      editOf('long.tex', long, 2_500),
    );
    const result = await world.send('extend line 2500');
    expect(world.requestAt(1).transcript[0]).toMatchObject({
      result: { tool: 'read_file', shown: { first: 1 } },
    });
    expect(world.requestAt(2).transcript[1]).toMatchObject({
      kind: 'mistake',
      problem: textContaining('line 2500 of long.tex was not shown to you'),
    });
    expect(world.requestAt(3).transcript[2]).toHaveProperty('result.shown', {
      first: 2_400,
      last: 2_600,
    });
    expect(result.message).toMatchObject({
      kind: 'proposal',
      edits: [{ path: 'long.tex', command: { target: { lineNumber: 2_500 } } }],
    });
  });

  it('asks for the comma that keeps the fields of a .bib entry separated', async () => {
    const field = (operation: 'insert_after' | 'replace', content: string): AgentDecision =>
      editsOf({
        path: 'refs.bib',
        command: createDocumentCommand({
          operation,
          target: { lineNumber: 2, lineText: '  title = {Smith}' },
          content,
        }),
      });
    const bib = ['@article{smith20,', '  title = {Smith}', '}'];
    world.project = new FakeProject(
      world.editor,
      { 'main.tex': MAIN, 'refs.bib': bib },
      'main.tex',
    );
    world.wireRequests();
    world.agent.will(
      readBib(),
      field('insert_after', '  year = {2020}'),
      field('replace', '  title = {Smith},\n  year = {2020}'),
    );
    const result = await world.send('add the year 2020 to smith20');
    expect(world.requestAt(2).transcript[1]).toMatchObject({
      kind: 'mistake',
      problem: textContaining('line 2 of refs.bib (title = {Smith}) is followed by another field'),
    });
    expect(result.message).toMatchObject({ kind: 'proposal', edits: [{ path: 'refs.bib' }] });
  });

  it('asks for a read of the lines when an edit relies only on search hits', async () => {
    world.agent.will(tool({ tool: 'search', query: 'smith' }), bibEdit(), readBib(), bibEdit());
    const result = await world.send('fix the smith entry');
    expect(world.requestAt(2).transcript[1]).toMatchObject({
      kind: 'mistake',
      problem: textContaining(
        'refs.bib was not read: the search results show only its matching lines 1, 2, and search hits are not enough to edit a file; read lines 1 to 8 of refs.bib',
      ),
    });
    expect(result.message).toMatchObject({ kind: 'proposal', edits: [{ path: 'refs.bib' }] });
  });

  it('sends a read starting past the end of the file back to the agent', async () => {
    world.agent.will(
      tool({ tool: 'read_file', path: 'refs.bib', range: { startLine: 9 } }),
      answer('The file is short.'),
    );
    await world.send('show the end of refs.bib');
    expect(world.requestAt(1).transcript).toEqual([
      {
        kind: 'mistake',
        decision: tool({ tool: 'read_file', path: 'refs.bib', range: { startLine: 9 } }),
        problem: 'the file has 3 lines, so it has no line 9; read from a line up to 3',
      },
    ]);
  });

  it('keeps each lookup in the conversation for the next requests', async () => {
    world.agent.will(readBib(), answer('One entry.'), answer('Still one.'));
    await world.send('how many entries has refs.bib?');
    await world.send('and now?');
    expect(world.conversation.messages().map((m) => m.role)).toEqual([
      'user',
      'tool',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(world.conversation.messages()[1]).toEqual({
      id: 'id-2',
      role: 'tool',
      record: {
        tool: 'read_file',
        path: 'refs.bib',
        shown: { first: 1, last: BIB.length },
        totalLines: BIB.length,
        lines: BIB,
      },
    });
    expect(world.requestAt(2).conversation).toEqual({
      summary: null,
      imported: null,
      messages: world.conversation.messages().slice(0, 3),
    });
    expect(world.repository.stored.get('session-1')?.messages).toEqual(
      world.conversation.messages(),
    );
  });

  it('searches every text file of the project', async () => {
    world.agent.will(tool({ tool: 'search', query: 'KNUTH' }), answer('Cited in main.tex.'));
    await world.send('where is knuth cited?');
    expect(world.project.reads.sort()).toEqual(['chapters/intro.tex', 'main.tex', 'refs.bib']);
    expect(world.requestAt(1).transcript[0]).toMatchObject({ kind: 'tool' });
    expect(world.requestAt(1).transcript[0]).toHaveProperty('result', {
      tool: 'search',
      matches: [
        { path: 'main.tex', lineNumber: 4, lineText: 'Numbers \\cite{knuth84}.' },
        { path: 'chapters/intro.tex', lineNumber: 1, lineText: 'Intro about knuth.' },
      ],
      truncated: false,
    });
    expect(world.progress).toContainEqual({ stage: 'searching', query: 'KNUTH' });
  });

  it('lets the main agent search only the whole project', async () => {
    world.agent.will(
      tool({ tool: 'search', query: 'knuth', path: 'chapters' }),
      answer('The intro mentions knuth.'),
    );
    await world.send('where is knuth mentioned in the chapters?');
    expect(world.project.reads).toEqual([]);
    expect(world.requestAt(1).transcript).toEqual([
      {
        kind: 'mistake',
        decision: tool({ tool: 'search', query: 'knuth', path: 'chapters' }),
        problem: 'search covers the whole project in this task and takes no path; remove the path',
      },
    ]);
  });

  it('cancels the other reads of a search when one fails and waits for them', async () => {
    const mainRead = Promise.withResolvers<DocumentSnapshot>();
    world.project.willRead('main.tex', new PendingStep(() => mainRead.promise));
    world.project.willRead('chapters/intro.tex', new PendingStep(rejectOnAbort));
    world.project.willRead('refs.bib', new ProjectFileReadError('404'));
    world.agent.will(tool({ tool: 'search', query: 'knuth' }));
    let settled = false;
    const sending = world.send('where is knuth cited?').finally(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(world.project.readSignal('main.tex').aborted).toBe(true);
    });
    expect(world.project.readSignal('chapters/intro.tex').aborted).toBe(true);
    expect(settled).toBe(false);
    mainRead.resolve(createDocumentSnapshot(MAIN));
    await expect(sending).rejects.toThrow(ProjectFileReadError);
    expect(world.agent.requests).toHaveLength(1);
  });

  it('reads at most a few files of a search at a time', async () => {
    const documents = Object.fromEntries(
      Array.from({ length: PARALLEL_SEARCH_READS + 2 }, (_, index) => [
        `part${String(index)}.tex`,
        ['text'],
      ]),
    );
    world.project = new FakeProject(world.editor, documents, 'part0.tex');
    world.wireRequests();
    const firstRead = Promise.withResolvers<DocumentSnapshot>();
    world.project.willRead('part0.tex', new PendingStep(() => firstRead.promise));
    world.project.holdsReads = true;
    world.agent.will(tool({ tool: 'search', query: 'text' }));
    const sending = world.send('find text');
    await vi.waitFor(() => {
      expect(world.project.reads).toHaveLength(PARALLEL_SEARCH_READS);
    });
    firstRead.resolve(createDocumentSnapshot(['text']));
    await vi.waitFor(() => {
      expect(world.project.reads).toHaveLength(PARALLEL_SEARCH_READS + 1);
    });
    expect(world.project.reads).toEqual(Object.keys(documents).slice(0, PARALLEL_SEARCH_READS + 1));
    const reset = world.startNew();
    await expect(sending).rejects.toThrow(RequestSupersededError);
    await reset;
  });

  it('compiles the project and hands the diagnostics to the agent', async () => {
    const diagnostics = [{ level: 'error' as const, message: 'Undefined control sequence.' }];
    world.project.willCompile(diagnostics);
    world.agent.will(tool({ tool: 'compile' }), answer('A typo on line 2.'));
    await world.send('why does it not compile?');
    expect(world.requestAt(1).transcript[0]).toEqual({
      kind: 'tool',
      call: { tool: 'compile' },
      result: { tool: 'compile', diagnostics },
    });
    expect(world.progress).toContainEqual({ stage: 'compiling' });
  });

  it('sends a repeated tool call back to the agent as a rejected step', async () => {
    const call = tool({ tool: 'read_file', path: 'refs.bib' });
    world.agent.will(call, call, answer('One entry.'));
    const result = await world.send('read it twice');
    expect(result.message).toMatchObject({ kind: 'explanation', text: 'One entry.' });
    expect(world.project.reads).toEqual(['refs.bib']);
    expect(world.requestAt(2).transcript[1]).toEqual({
      kind: 'mistake',
      decision: call,
      problem: 'read_file was already called with the same argument; use its earlier result',
    });
  });

  it('sends a tool call beyond the budget back to the agent', async () => {
    const queries = Array.from({ length: MAIN_AGENT_POLICY.maxToolCalls + 1 }, (_, index) =>
      tool({ tool: 'search', query: `query ${String(index)}` }),
    );
    world.agent.will(...queries, answer('Nothing found.'));
    await expect(world.send('search forever')).resolves.toMatchObject({
      message: { kind: 'explanation' },
    });
    expect(world.requestAt(-1).transcript.at(-1)).toMatchObject({
      kind: 'mistake',
      problem: textContaining('lookups are used'),
    });
  });

  it.each([
    [
      'a read of a file missing from the project',
      tool({ tool: 'read_file', path: 'gone.tex' }),
      'The project has no file gone.tex.',
    ],
    [
      'a read of a binary file',
      tool({ tool: 'read_file', path: 'figures/plot.png' }),
      'figures/plot.png is not a text file.',
    ],
    ['an edit of a file missing from the project', editOf('gone.tex', MAIN, 4), 'no file gone.tex'],
    ['an edit of a file it has not read', bibEdit(), 'refs.bib must be read with read_file'],
    [
      'an edit whose line does not match its quote',
      editAt('main.tex', 2, '\\section{Results}'),
      'The quoted text starts line 3, not line 2',
    ],
    [
      'an edit range past the end of the file',
      editsOf({
        path: 'main.tex',
        command: createDocumentCommand({
          operation: 'delete',
          target: { lineNumber: 4, lineText: itemAt(MAIN, 3, 'line') },
          lineCount: 3,
        }),
      }),
      'run past the end of the document',
    ],
  ])('sends %s back to the agent to correct', async (_name, mistake, problem) => {
    world.agent.will(mistake, answer('Corrected.'));
    await expect(world.send('do it')).resolves.toMatchObject({ message: { text: 'Corrected.' } });
    expect(world.requestAt(1).transcript).toEqual([
      { kind: 'mistake', decision: mistake, problem: textContaining(problem) },
    ]);
    expect(world.editor.preview).toBeNull();
    expect(world.project.reads).toEqual([]);
  });

  it('gives up after too many consecutive mistakes', async () => {
    const mistakes = Array.from({ length: MAIN_AGENT_POLICY.maxConsecutiveMistakes }, () =>
      editOf('gone.tex', MAIN, 4),
    );
    world.agent.will(...mistakes);
    await expect(world.send('add more')).rejects.toThrow(AgentMistakeLimitError);
    expect(world.agent.requests).toHaveLength(MAIN_AGENT_POLICY.maxConsecutiveMistakes);
    expect(world.pendingChanges.discardAll()).toEqual([]);
    expect(world.editor.preview).toBeNull();
  });

  it('starts counting mistakes again after a successful tool call', async () => {
    const mistake = editOf('gone.tex', MAIN, 4);
    const almost = MAIN_AGENT_POLICY.maxConsecutiveMistakes - 1;
    world.agent.will(
      ...Array.from({ length: almost }, () => mistake),
      tool({ tool: 'compile' }),
      ...Array.from({ length: almost }, () => mistake),
      answer('Done.'),
    );
    world.project.willCompile([]);
    await expect(world.send('add more')).resolves.toMatchObject({ message: { text: 'Done.' } });
  });

  it('opens the file of an edit to preview it while the user stays on the request file', async () => {
    world.project.switchTo('refs.bib');
    world.agent.will(tool({ tool: 'read_file', path: 'main.tex' }), mainEdit());
    const result = await world.send('add more');
    expect(world.project.opened).toEqual(['main.tex']);
    expect(result).toMatchObject({ kind: 'proposal', previewShown: true });
    expect(result.message).toHaveProperty('edits.0.command', world.editor.preview?.[0]?.command);
  });

  it('keeps the file the user switched to during the request and previews nothing', async () => {
    world.agent.onDecide = () => {
      world.project.switchTo('refs.bib');
    };
    world.agent.will(mainEdit());
    const result = await world.send('add more');
    expect(world.project.opened).toEqual([]);
    expect(world.project.shownFile().path).toBe('refs.bib');
    expect(world.editor.preview).toBeNull();
    expect(result).toMatchObject({ kind: 'proposal', previewShown: false });
    expect(world.project.reads.at(-1)).toBe('main.tex');
    expect(world.pendingChanges.selectFile(changeIdOf(result), 'main.tex')).toHaveLength(1);
  });

  it('previews the edits of the file the user switched to during the request', async () => {
    world.agent.onDecide = () => {
      world.project.switchTo('refs.bib');
    };
    world.agent.will(
      readBib(),
      editsOf(insertionOf('main.tex', MAIN, 4), insertionOf('refs.bib', BIB, 3)),
    );
    const result = await world.send('add more');
    expect(world.project.opened).toEqual([]);
    expect(result).toMatchObject({ kind: 'proposal', previewShown: true });
    expect(world.editor.preview?.map(({ command }) => command.target.lineNumber)).toEqual([3]);
  });

  it('drops an edit of a file the user left when that file changed meanwhile', async () => {
    world.agent.onDecide = () => {
      world.editor.lines[0] = '\\section{Introduction}';
      world.project.switchTo('refs.bib');
    };
    world.agent.will(mainEdit());
    await expect(world.send('add more')).rejects.toThrow(DocumentConflictError);
    expect(world.editor.preview).toBeNull();
  });

  it('drops an edit whose file changed before it was opened', async () => {
    world.project.onOpen = () => {
      world.editor.lines[0] = '@book{knuth84,';
    };
    world.agent.will(tool({ tool: 'read_file', path: 'refs.bib' }), bibEdit());
    await expect(world.send('add knuth84')).rejects.toThrow(DocumentConflictError);
    expect(world.editor.preview).toBeNull();
    expect(world.conversation.messages().map((m) => m.role)).toEqual(['user', 'tool', 'notice']);
  });

  it('drops an edit when the document changed while the agent was working', async () => {
    world.agent.onDecide = () => {
      world.editor.lines[0] = '\\section{Introduction}';
    };
    world.agent.will(mainEdit());
    await expect(world.send('add more')).rejects.toThrow(DocumentConflictError);
    expect(world.editor.preview).toBeNull();
    expect(world.conversation.messages().map((m) => m.role)).toEqual(['user', 'notice']);
  });

  it('drops an edit whose preview fails', async () => {
    world.agent.will(mainEdit());
    world.editor.previewFailure = new EditorUnavailableError('gone');
    await expect(world.send('add more')).rejects.toThrow(EditorUnavailableError);
    expect(world.conversation.messages().map((m) => m.role)).toEqual(['user', 'notice']);
  });

  it('propagates agent failures', async () => {
    world.agent.will(new AssistantUnreachableError('down'));
    await expect(world.send('summarize')).rejects.toThrow(AssistantUnreachableError);
    world.agent.will(new AssistantProtocolError('bad'));
    await expect(world.send('summarize')).rejects.toThrow(AssistantProtocolError);
  });

  it.each([
    ['reading a file', 'readFile' as const, new ProjectFileReadError('404')],
    ['opening a file', 'openFile' as const, new FileOpenTimeoutError('slow')],
  ])('propagates a project failure while %s', async (_name, method, error) => {
    world.project.failure[method] = error;
    world.agent.will(tool({ tool: 'read_file', path: 'refs.bib' }), bibEdit());
    await expect(world.send('add knuth84')).rejects.toThrow(error);
    expect(world.editor.preview).toBeNull();
  });

  it('propagates a compile timeout', async () => {
    world.project.willCompile(new CompileTimeoutError('no log'));
    world.agent.will(tool({ tool: 'compile' }));
    await expect(world.send('does it compile?')).rejects.toThrow(CompileTimeoutError);
  });

  it('requires the project and the editor before asking the agent', async () => {
    world.project.failure.listFiles = new ProjectUnavailableError('no tree');
    await expect(world.send('summarize')).rejects.toThrow(ProjectUnavailableError);
    world.project.failure = {};
    world.editor.available = false;
    await expect(world.send('summarize')).rejects.toThrow(EditorUnavailableError);
    expect(world.agent.requests).toHaveLength(0);
    expect(world.conversation.messages().map((m) => m.role)).toEqual([
      'user',
      'notice',
      'user',
      'notice',
    ]);
  });

  it('waits for the editor to show the open file and never mixes up two files', async () => {
    world.editor.shownFileId = 'doc:refs.bib';
    await expect(world.send('summarize')).rejects.toThrow(EditorShowsOtherFileError);
    expect(world.agent.requests).toHaveLength(0);
    expect(world.project.signals).toHaveLength(1);
  });

  it('accepts one request at a time', async () => {
    world.agent.will(answer('A short paper.'));
    const first = world.send('What is this document about?');
    await expect(world.send('And the second one?')).rejects.toThrow(RequestInProgressError);
    await expect(first).resolves.toMatchObject({ message: { kind: 'explanation' } });
  });

  it('discards the open change when a new request starts and records it', async () => {
    const changeId = await world.proposeEdit();
    world.progress = [];
    world.agent.will(answer('Hi.'));
    await world.send('hi');
    expect(world.editor.preview).toBeNull();
    const discarded = {
      id: changeId,
      kind: 'proposal',
      edits: [expect.objectContaining({ status: 'discarded' })],
    };
    expect(world.progress[0]).toMatchObject({ stage: 'decided', message: discarded });
    expect(world.storedMessages()).toContainEqual(expect.objectContaining(discarded));
    expect(world.requestAt(-1).conversation.messages).toContainEqual(
      expect.objectContaining(discarded),
    );
    await expect(world.apply.execute(changeId, null, world.record)).rejects.toThrow(
      ChangeNoLongerPendingError,
    );
    await expect(world.reject.execute(changeId, null, world.record)).rejects.toThrow(
      ChangeNoLongerPendingError,
    );
  });
});

describe('context usage', () => {
  it('keeps the last usage the main agent measured with the session', async () => {
    world.agent.will(readBib(), answer('Read.'));
    await world.send('read the bibliography');
    expect(world.conversation.contextUsage).toMatchObject({ promptTokens: 2_000 });
    expect(world.repository.only().contextUsage).toMatchObject({ promptTokens: 2_000 });
    const read = new ReadContextUsage({ conversation: world.conversation, agent: world.agent });
    expect(read.execute()).toMatchObject({ promptTokens: 2_000 });
    await world.startNew();
    expect(read.execute()).toEqual(world.agent.idleUsage);
  });

  it('does not take the usage of a subagent for the session', async () => {
    world.agent.will(
      tool({ tool: 'delegate', task: 'Check every citation key', files: [] }),
      answer('knuth84 is cited on line 4.'),
      answer('Checked.'),
    );
    const seen: (number | undefined)[] = [];
    world.agent.onDecide = () => {
      seen.push(world.conversation.contextUsage?.promptTokens);
    };
    await world.send('check the citations');
    expect(seen).toEqual([undefined, 1_000, 1_000]);
    expect(world.conversation.contextUsage).toMatchObject({ promptTokens: 3_000 });
  });
});

describe('imported history', () => {
  const imported = { path: 'hans-sessions/2026-10-02-070500-a.json', lastMessageId: 'a' };

  it('shows the agent which part of the history was imported', async () => {
    world.seed({
      ...storedSession('imported', [
        { id: 'u', role: 'user', text: 'from a file' },
        { id: 'a', role: 'assistant', kind: 'explanation', text: 'Imported answer.' },
      ]),
      imported,
    });
    await world.restore();
    world.agent.will(answer('Own answer.'));
    await world.send('my own question');
    expect(world.requestAt(0).conversation).toMatchObject({
      imported: { path: imported.path, messageCount: 2 },
    });
    world.agent.will(answer('Later.'));
    await world.send('another one');
    expect(world.requestAt(1).conversation.imported).toEqual({
      path: imported.path,
      messageCount: 2,
    });
  });
});

describe('conversation reset during a request', () => {
  it('cancels the running request and frees the assistant at once', async () => {
    world.agent.will(new PendingStep(rejectOnAbort));
    const running = world.send('summarize');
    await vi.waitFor(() => {
      expect(world.agent.requests).toHaveLength(1);
    });
    const reset = world.startNew();
    await expect(running).rejects.toThrow(RequestSupersededError);
    await reset;
    expect(world.isBusy()).toBe(false);
    world.agent.will(answer('Fresh.'));
    await expect(world.send('summarize again')).resolves.toMatchObject({
      message: { text: 'Fresh.' },
    });
  });

  it('drops the late reply instead of adding it to the new conversation', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.agent.will(
      new PendingStep(async () => {
        await gate;
        return mainEdit();
      }),
    );
    const running = world.send('add');
    const reset = world.startNew();
    release();
    await expect(running).rejects.toThrow(RequestSupersededError);
    await reset;
    expect(world.conversation.messages()).toHaveLength(0);
    expect(world.editor.preview).toBeNull();
  });

  it('drops the request when the conversation is reset during a tool call', async () => {
    world.agent.will(tool({ tool: 'compile' }));
    world.project.willCompile(
      new PendingStep(() => {
        world.resetLater();
        return Promise.resolve([]);
      }),
    );
    await expect(world.send('does it compile?')).rejects.toThrow(RequestSupersededError);
    await Promise.all(world.resets);
    expect(world.agent.requests).toHaveLength(1);
  });
});
