import { describe, expect, it } from 'vitest';
import type { ReadRecord, ToolRecord } from '../../../src/domain/agent-transcript';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { ProjectFileKind } from '../../../src/domain/project-file';
import { createAgentExchange } from '../../../src/infrastructure/ollama/agent-protocol';
import { findOutdatedReads } from '../../../src/infrastructure/ollama/outdated-reads';
import type { AgentStepRequest } from '../../../src/ports/agent-port';

const read = (path: string, first: number, last: number): ReadRecord => ({
  tool: 'read_file',
  path,
  shown: { first, last },
  totalLines: 100,
  lines: Array.from({ length: last - first + 1 }, (_, index) => `${path} ${String(first + index)}`),
});

describe('findOutdatedReads', () => {
  it('marks a read whose lines a later read of the same file shows again', () => {
    const old = read('a.tex', 10, 20);
    const partial = read('a.tex', 1, 15);
    const other = read('b.tex', 1, 100);
    const search: ToolRecord = { tool: 'search', query: 'q', matches: [], truncated: false };
    const newer = read('a.tex', 5, 30);
    const outdated = findOutdatedReads([old, partial, other, search, newer]);
    expect([...outdated]).toEqual([old]);
  });

  it('keeps the latest read of every file', () => {
    const first = read('a.tex', 1, 50);
    const again = read('a.tex', 1, 50);
    expect([...findOutdatedReads([first, again])]).toEqual([first]);
  });
});

describe('outdated reads in the prompt', () => {
  const step: AgentStepRequest = {
    request: { kind: 'user', message: { id: 'r', role: 'user', text: 'Check a.tex' } },
    conversation: {
      summary: null,
      messages: [
        { id: 'u', role: 'user', text: 'Read a.tex' },
        { id: 't', role: 'tool', record: read('a.tex', 1, 3) },
      ],
    },
    workspace: {
      files: [
        { id: '1', path: 'main.tex', kind: ProjectFileKind.Text },
        { id: '2', path: 'a.tex', kind: ProjectFileKind.Text },
      ],
      openFile: { path: 'main.tex', document: createDocumentSnapshot(['x']) },
      cursorLine: 1,
      selection: '',
    },
    transcript: [
      {
        kind: 'tool',
        call: { tool: 'read_file', path: 'a.tex' },
        result: {
          tool: 'read_file',
          path: 'a.tex',
          document: createDocumentSnapshot(['fresh 1', 'fresh 2', 'fresh 3']),
          shown: { first: 1, last: 3 },
        },
      },
    ],
    signal: new AbortController().signal,
  };

  it('replaces an earlier read by a notice and leaves the stored history as it was', () => {
    const stored = structuredClone(step.conversation);
    const { prompt } = createAgentExchange(step, 40_000).request;
    expect(prompt).toContain(
      '[tool] read_file a.tex lines 1–3 of 100:\n[outdated — see the later read of a.tex]',
    );
    expect(prompt).not.toContain('a.tex 1');
    expect(prompt).toContain('Result 1 (read_file a.tex):\n1: fresh 1\n2: fresh 2\n3: fresh 3');
    expect(step.conversation).toEqual(stored);
  });
});
