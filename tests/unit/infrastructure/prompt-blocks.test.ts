import { describe, expect, it } from 'vitest';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { createDocumentCommand } from '../../../src/domain/document-command';
import { ProjectFileKind } from '../../../src/domain/project-file';
import { createAgentExchange } from '../../../src/infrastructure/ollama/agent-protocol';
import type { AgentStepRequest } from '../../../src/ports/agent-port';
import { TestFixtureError } from '../../support/test-errors';

const budget = 20_480;
const conversation = Array.from({ length: 15 }, (_, i) => ({
  id: String(i),
  role: 'user' as const,
  text: `message ${String(i)}`,
}));

const request = (overrides: Partial<AgentStepRequest> = {}): AgentStepRequest => ({
  request: { id: 'r', role: 'user', text: 'm' },
  conversation: [],
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
      request: { id: 'r', role: 'system', text: 'Fix the first error.' },
      conversation: [
        { id: '1', role: 'user', text: 'Dodaj tabelę wyników' },
        { id: '2', role: 'assistant', kind: 'explanation', text: 'Gotowe.' },
      ],
    });
    expect(prompt).toContain(
      "System request (sent by the editor, not typed by the user):\nFix the first error.\n\nThe user's last message, whose language your texts use:\nDodaj tabelę wyników",
    );
    expect(prompt).not.toContain('User message:');
  });

  it('carries the message and the last 12 turns', () => {
    const prompt = promptOf({
      request: { id: 'r', role: 'user', text: 'Add a table' },
      conversation,
    });
    expect(prompt).toContain('User message:\nAdd a table');
    expect(prompt).toContain('[user] message 14');
    expect(prompt).toContain('[user] message 3');
    expect(prompt).not.toContain('[user] message 2\n');
  });

  it('shows a request the assistant made on its own as a system line', () => {
    const prompt = promptOf({
      conversation: [{ id: 's', role: 'system', text: 'Compiling reports errors.' }],
    });
    expect(prompt).toContain('Conversation so far:\n[system] Compiling reports errors.');
  });

  it.each([
    ['proposed', '[proposal left undecided]'],
    ['applied', '[proposal applied]'],
    ['rejected', '[proposal rejected]'],
  ] as const)(
    'shows a %s proposal to the model with its outcome, place and content',
    (status, outcome) => {
      const proposal = {
        id: 'p',
        role: 'assistant' as const,
        kind: 'proposal' as const,
        path: 'main.tex',
        command: createDocumentCommand({
          operation: 'replace',
          target: { lineNumber: 2, lineText: 'Body.' },
          content: 'New body.',
          reason: 'Clearer.',
        }),
        status,
      };
      expect(promptOf({ conversation: [proposal] })).toContain(
        `[assistant] ${outcome} main.tex line 2: replace (Clearer.)\nNew body.`,
      );
    },
  );
});

describe('compaction', () => {
  it('keeps the head and the tail of a long block and says how much it left out', () => {
    const selection = 'a'.repeat(50_000) + 'b'.repeat(50_000);
    const compacted =
      /Selected text:\n(a+)\n\n\[AUTOCOMPACTED: omitted (\d+) chars\]\n\n(b+)\n/.exec(
        promptOf(withSelection(selection)),
      );
    if (compacted === null) throw new TestFixtureError('the selection was not compacted');
    const [, head = '', omitted, tail = ''] = compacted;
    expect(head.length).toBe(tail.length);
    expect(head.length + Number(omitted) + tail.length).toBe(selection.length);
  });

  it('leaves a block that fits untouched', () => {
    const prompt = promptOf(withSelection('short'));
    expect(prompt).toContain('Selected text:\nshort');
    expect(prompt).not.toContain('AUTOCOMPACTED');
  });
});
