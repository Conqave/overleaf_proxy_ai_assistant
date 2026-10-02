import { EMPTY_CONVERSATION } from '../../support/fakes';
import { describe, expect, it } from 'vitest';
import { AGENT_POLICY } from '../../../src/domain/agent-policy';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { ProjectFileKind } from '../../../src/domain/project-file';
import { createAgentExchange } from '../../../src/infrastructure/ollama/agent-protocol';
import type { AgentStepRequest } from '../../../src/ports/agent-port';
import { viewConversation } from '../../../src/domain/conversation-view';
import { TestFixtureError } from '../../support/test-errors';
import { editWith, proposalOf } from '../../support/proposals';

const budget = 20_480;
const conversation = Array.from({ length: 15 }, (_, i) => ({
  id: String(i),
  role: 'user' as const,
  text: `message ${String(i)}`,
}));

const request = (overrides: Partial<AgentStepRequest> = {}): AgentStepRequest => ({
  request: { kind: 'user', message: { id: 'r', role: 'user', text: 'm' } },
  conversation: EMPTY_CONVERSATION,
  signal: new AbortController().signal,
  workspace: {
    files: [{ id: '1', path: 'main.tex', kind: ProjectFileKind.Text }],
    openFile: { path: 'main.tex', document: createDocumentSnapshot(['\\section{A}', 'Body.']) },
    cursorLine: 1,
    selection: '',
  },
  transcript: [],
  ...overrides,
});

const promptOf = (overrides: Partial<AgentStepRequest>): string =>
  createAgentExchange(request(overrides), budget).request.prompt;

const withSelection = (selection: string): Partial<AgentStepRequest> => ({
  workspace: { ...request().workspace, selection },
});

describe('conversation history', () => {
  it('labels a request of the editor as a system request in the language of the user', () => {
    const prompt = promptOf({
      request: {
        kind: 'compile-fix',
        message: { id: 'r', role: 'system', text: 'Fix the first error.' },
        diagnostics: [],
      },
      conversation: {
        summary: null,
        messages: [
          { id: '1', role: 'user', text: 'Dodaj tabelę wyników' },
          { id: '2', role: 'assistant', kind: 'explanation', text: 'Gotowe.' },
        ],
      },
    });
    expect(prompt).toContain(
      "System request (sent by the editor, not typed by the user):\nFix the first error.\n\nThe user's last message, whose language your texts use:\nDodaj tabelę wyników",
    );
    expect(prompt).not.toContain('User message:');
  });

  it('attaches the compile result of a compile-fix request without using a lookup', () => {
    const prompt = promptOf({
      request: {
        kind: 'compile-fix',
        message: { id: 'r', role: 'system', text: 'Fix the first error.' },
        diagnostics: [
          {
            level: 'error',
            message: 'Undefined control sequence.',
            path: 'main.tex',
            lineNumber: 2,
          },
        ],
      },
    });
    expect(prompt).toContain(
      'Compile result after the applied change:\nerror main.tex:2: Undefined control sequence.',
    );
    expect(prompt).not.toContain('Result 1');
    expect(prompt).toContain(`Lookups left: ${String(AGENT_POLICY.maxToolCalls)}`);
  });

  it('carries the message and the whole conversation', () => {
    const prompt = promptOf({
      request: { kind: 'user', message: { id: 'r', role: 'user', text: 'Add a table' } },
      conversation: { summary: null, messages: conversation },
    });
    expect(prompt).toContain('User message:\nAdd a table');
    expect(prompt).toContain('Conversation so far:\n[user] message 0\n');
    expect(prompt).toContain('[user] message 14');
  });

  it('shows earlier lookups shortened, the part they show first and the shortening last', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `Line ${String(i + 1)} of the chapter.`);
    const prompt = promptOf({
      conversation: viewConversation([
        {
          id: 't',
          role: 'tool',
          record: {
            tool: 'read_file',
            path: 'ch.tex',
            shown: { first: 1, last: 300 },
            totalLines: 900,
            lines,
          },
        },
        {
          id: 's',
          role: 'tool',
          record: { tool: 'search', query: 'fig', matches: [], truncated: false },
        },
      ]),
    });
    const read =
      /\[tool\] read_file ch\.tex lines 1–300 of 900:\n\[Showing only lines 1–300 of 900; the file has 900 lines and the others exist but are not shown here\. Read another range with START_LINE and END_LINE, or search\.\]\n1: Line 1[^]*?\n\[tool\]/.exec(
        prompt,
      );
    if (read === null) throw new TestFixtureError('the earlier read is missing');
    expect(read[0]).toContain('[AUTOCOMPACTED: omitted');
    expect(read[0]).toContain('300: Line 300 of the chapter.');
    expect(read[0]).toContain(
      '300: Line 300 of the chapter.\n[shortened to 2000 characters; repeat the lookup to see it whole]',
    );
    expect(read[0].length).toBeLessThan(2_400);
    expect(prompt).toContain('[tool] search "fig":\n(no matches)');
  });

  it('shows a request the assistant made on its own as a system line', () => {
    const prompt = promptOf({
      conversation: viewConversation([
        { id: 's', role: 'system', text: 'Compiling reports errors.' },
      ]),
    });
    expect(prompt).toContain('Conversation so far:\n[system] Compiling reports errors.');
  });

  it.each([
    ['proposed', '[proposal left undecided]'],
    ['applied', '[proposal applied]'],
    ['rejected', '[proposal rejected]'],
    ['failed', '[proposal failed to apply]'],
    ['discarded', '[proposal discarded without a decision]'],
  ] as const)(
    'shows a %s proposal to the model with its outcome, place and content',
    (status, outcome) => {
      const proposal = proposalOf(
        'p',
        editWith(
          'main.tex',
          createDocumentCommand({
            operation: 'replace',
            target: { lineNumber: 2, lineText: 'Body.' },
            content: 'New body.',
            reason: 'Clearer.',
          }),
          status,
        ),
      );
      expect(promptOf({ conversation: viewConversation([proposal]) })).toContain(
        `[assistant] ${outcome} main.tex line 2: replace (Clearer.)\nNew body.`,
      );
    },
  );
});

describe('change history', () => {
  it('tells the model which files the user undid and which were left as they are', () => {
    const notice = {
      id: 'n',
      role: 'undo' as const,
      proposalId: 'p',
      undone: ['main.tex'],
      refused: [{ path: 'refs.bib', problem: 'refs.bib changed after Hans edited it.' }],
    };
    expect(promptOf({ conversation: viewConversation([notice]) })).toContain(
      '[editor] The user undid the applied edits of an earlier change in main.tex; those files are back as they were before it.\nrefs.bib was not undone: refs.bib changed after Hans edited it.',
    );
  });

  it('shows an undone edit to the model as applied and then undone', () => {
    const command = createDocumentCommand({
      operation: 'delete',
      target: { lineNumber: 3, lineText: 'Old.' },
    });
    expect(
      promptOf({
        conversation: viewConversation([proposalOf('p', editWith('main.tex', command, 'undone'))]),
      }),
    ).toContain('[assistant] [proposal applied, then undone by the user] main.tex line 3: delete');
  });

  it('shows the model the outcome of every edit of a change', () => {
    const replace = createDocumentCommand({
      operation: 'replace',
      target: { lineNumber: 2, lineText: '\\label{sec:old}' },
      content: '\\label{sec:new}',
    });
    const remove = createDocumentCommand({
      operation: 'delete',
      target: { lineNumber: 7, lineText: 'Old.' },
      lineCount: 2,
      reason: 'Drops the old note.',
    });
    const change = proposalOf(
      'p',
      editWith('chapters/results.tex', replace, 'applied'),
      editWith('main.tex', remove, 'rejected'),
    );
    expect(promptOf({ conversation: viewConversation([change]) })).toContain(
      [
        '[assistant] [change of 2 edits]',
        '[edit 1 applied] chapters/results.tex line 2: replace',
        '\\label{sec:new}',
        '[edit 2 rejected] main.tex lines 7-8: delete (Drops the old note.)',
      ].join('\n'),
    );
  });
});

describe('compaction', () => {
  it('keeps the head and the tail of a long block and says how much it left out', () => {
    const selection = 'a'.repeat(50_000) + 'b'.repeat(50_000);
    const compacted =
      /Selected text \(in the open file; a request to change, fix or translate it asks for an edit of that file\):\n(a+)\n\n\[AUTOCOMPACTED: omitted (\d+) chars\]\n\n(b+)\n/.exec(
        promptOf(withSelection(selection)),
      );
    if (compacted === null) throw new TestFixtureError('the selection was not compacted');
    const [, head = '', omitted, tail = ''] = compacted;
    expect(head.length).toBe(tail.length);
    expect(head.length + Number(omitted) + tail.length).toBe(selection.length);
  });

  it('leaves a block that fits untouched', () => {
    const prompt = promptOf(withSelection('short'));
    expect(prompt).toContain(
      'Selected text (in the open file; a request to change, fix or translate it asks for an edit of that file):\nshort',
    );
    expect(prompt).not.toContain('AUTOCOMPACTED');
  });
});
