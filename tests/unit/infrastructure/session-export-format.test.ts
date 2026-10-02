import { describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '../../../src/domain/conversation';
import { createDocumentCommand } from '../../../src/domain/document-command';
import type { SessionExport } from '../../../src/domain/session-export';
import {
  MAX_SESSION_EXPORT_CHARS,
  parseSessionExport,
  SESSION_EXPORT_FORMAT,
  serializeSessionExport,
} from '../../../src/infrastructure/persistence/session-export-format';
import { UnknownStoredFormatError } from '../../../src/infrastructure/persistence/stored-fields';

const messages: ConversationMessage[] = [
  { id: '1', role: 'user', text: 'Fix \\begin{table} and "quotes"' },
  {
    id: '2',
    role: 'assistant',
    kind: 'proposal',
    edits: [
      {
        path: 'main.tex',
        command: createDocumentCommand({
          operation: 'replace',
          target: { lineNumber: 4, lineText: 'Numbers.' },
          content: '\\begin{table}\n\\hline\n\\end{table}',
          reason: 'Adds a table.',
        }),
        status: 'proposed',
      },
    ],
  },
  {
    id: '3',
    role: 'tool',
    record: {
      tool: 'search',
      query: '\\label',
      matches: [{ path: 'main.tex', lineNumber: 3, lineText: '\\label{x}' }],
      truncated: false,
    },
  },
  {
    id: '4',
    role: 'tool',
    record: {
      tool: 'delegate',
      task: 'Check every \\cite key against refs.bib',
      files: ['main.tex', 'refs.bib'],
      report: {
        outcome: 'finished',
        text: 'main.tex:4 \\cite{a}: missing',
        truncated: false,
        lookups: 2,
      },
    },
  },
  {
    id: '5',
    role: 'tool',
    record: {
      tool: 'delegate',
      task: 'List the tables of chapter 2',
      files: [],
      report: { outcome: 'failed', problem: 'the subagent stopped', lookups: 0 },
    },
  },
  { id: '6', role: 'assistant', kind: 'explanation', text: 'Zażółć **gęślą** jaźń.' },
];

const exported: SessionExport = {
  projectId: 'project-1',
  exportedBy: 'user-1',
  exportedAt: 1_790_000_000_000,
  session: { title: 'Fix the table', createdAt: 10, updatedAt: 20, messages },
};

function documentWith(change: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(serializeSessionExport(exported)), ...change });
}

describe('session export format', () => {
  it('reads back exactly what it wrote, LaTeX and subagent results included', () => {
    const text = serializeSessionExport(exported);
    expect(JSON.parse(text)).toMatchObject({ format: SESSION_EXPORT_FORMAT });
    expect(parseSessionExport(text)).toEqual(exported);
  });

  it('is indented JSON ending with a newline', () => {
    const text = serializeSessionExport(exported);
    expect(text.startsWith(`{\n  "format": "${SESSION_EXPORT_FORMAT}",`)).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it.each([
    ['text that is no JSON', '{"format": '],
    ['a JSON list', '[]'],
    ['an unknown format', documentWith({ format: 'hans-session-export/2' })],
    ['a missing format', documentWith({ format: undefined })],
    ['an empty project', documentWith({ projectId: '' })],
    ['a missing exporter', documentWith({ exportedBy: undefined })],
    ['a fractional export time', documentWith({ exportedAt: 1.5 })],
    ['a missing session', documentWith({ session: undefined })],
    ['an empty title', documentWith({ session: { ...exported.session, title: '' } })],
    [
      'a message of unknown role',
      documentWith({ session: { ...exported.session, messages: [{ id: 'x', role: 'robot' }] } }),
    ],
    [
      'an edit that escapes the project',
      documentWith({
        session: {
          ...exported.session,
          messages: [
            {
              id: 'x',
              role: 'assistant',
              kind: 'proposal',
              edits: [{ path: '../main.tex', command: {}, status: 'proposed' }],
            },
          ],
        },
      }),
    ],
    [
      'a subagent result without its report',
      documentWith({
        session: {
          ...exported.session,
          messages: [
            {
              id: 'x',
              role: 'tool',
              record: { tool: 'delegate', task: 'Check every key', files: [] },
            },
          ],
        },
      }),
    ],
  ])('refuses %s', (_, text) => {
    expect(() => parseSessionExport(text)).toThrow(UnknownStoredFormatError);
  });

  it('refuses a file over the size limit without parsing it', () => {
    const text = serializeSessionExport(exported);
    const padded = `${text}${' '.repeat(MAX_SESSION_EXPORT_CHARS - text.length + 1)}`;
    const parse = vi.spyOn(JSON, 'parse');
    expect(() => parseSessionExport(padded)).toThrow(
      `larger than ${String(MAX_SESSION_EXPORT_CHARS)} characters`,
    );
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(parseSessionExport(padded.slice(0, MAX_SESSION_EXPORT_CHARS))).toEqual(exported);
  });
});
