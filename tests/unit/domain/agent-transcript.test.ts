import { describe, expect, it } from 'vitest';
import {
  assertEditShown,
  createReadRecord,
  getShownDocument,
  recordToolTurn,
  type AgentTurn,
  type ToolTurn,
} from '../../../src/domain/agent-transcript';
import { createDocumentSnapshot, type DocumentSnapshot } from '../../../src/domain/document';
import { createDocumentCommand } from '../../../src/domain/document-command';
import {
  InvalidToolRecordError,
  UnreadFileEditError,
  UnshownLinesEditError,
} from '../../../src/domain/errors';
import type { LineSpan } from '../../../src/domain/read-window';

const open = { path: 'main.tex', document: createDocumentSnapshot(['open']) };
const bib = createDocumentSnapshot(
  Array.from({ length: 10 }, (_, index) => `line ${String(index)}`),
);

function read(path: string, document: DocumentSnapshot, shown: LineSpan): ToolTurn {
  return {
    kind: 'tool',
    call: { tool: 'read_file', path },
    result: { tool: 'read_file', path, document, shown },
  };
}

const whole = (document: DocumentSnapshot): LineSpan => ({
  first: 1,
  last: document.lines.length,
});

describe('getShownDocument', () => {
  it('gives the open file as shown whole in the workspace', () => {
    expect(getShownDocument(open, [], 'main.tex')).toEqual({
      document: open.document,
      spans: [{ first: 1, last: 1 }],
    });
  });

  it('gives the latest read of another file', () => {
    const old = createDocumentSnapshot(['old']);
    const fresh = createDocumentSnapshot(['new']);
    const shown = getShownDocument(
      open,
      [read('refs.bib', old, whole(old)), read('refs.bib', fresh, whole(fresh))],
      'refs.bib',
    );
    expect(shown).toEqual({ document: fresh, spans: [{ first: 1, last: 1 }] });
  });

  it('joins the ranges of reads that saw the same document', () => {
    const shown = getShownDocument(
      open,
      [read('refs.bib', bib, { first: 1, last: 3 }), read('refs.bib', bib, { first: 7, last: 9 })],
      'refs.bib',
    );
    expect(shown.spans).toEqual([
      { first: 1, last: 3 },
      { first: 7, last: 9 },
    ]);
  });

  it('ignores a rejected read', () => {
    const rejected: AgentTurn = {
      kind: 'mistake',
      decision: { kind: 'tool', call: { tool: 'read_file', path: 'refs.bib' } },
      problem: 'no',
    };
    expect(() => getShownDocument(open, [rejected], 'refs.bib')).toThrow(UnreadFileEditError);
  });

  it('rejects an edit of a file the model has not seen', () => {
    expect(() => getShownDocument(open, [], 'refs.bib')).toThrow(UnreadFileEditError);
  });
});

describe('assertEditShown', () => {
  const shown = { document: bib, spans: [{ first: 2, last: 4 }] };
  const replace = (lineNumber: number, lineCount: number) =>
    createDocumentCommand({
      operation: 'replace',
      target: { lineNumber, lineText: `line ${String(lineNumber - 1)}` },
      lineCount,
      content: 'x',
    });

  it('accepts an edit of shown lines', () => {
    expect(() => {
      assertEditShown('refs.bib', shown, replace(2, 3));
    }).not.toThrow();
    expect(() => {
      assertEditShown(
        'refs.bib',
        shown,
        createDocumentCommand({
          operation: 'insert_after',
          target: { lineNumber: 4, lineText: 'line 3' },
          content: 'x',
        }),
      );
    }).not.toThrow();
  });

  it('rejects an edit that reaches past the shown lines', () => {
    expect(() => {
      assertEditShown('refs.bib', shown, replace(3, 3));
    }).toThrow(
      new UnshownLinesEditError(
        'line 5 of refs.bib was not shown to you; read lines 3 to 5 with read_file (START_LINE and END_LINE) before editing them',
      ),
    );
  });

  it('rejects an anchor outside the shown lines', () => {
    expect(() => {
      assertEditShown(
        'refs.bib',
        shown,
        createDocumentCommand({
          operation: 'insert_before',
          target: { lineNumber: 8, lineText: 'line 7' },
          content: 'x',
        }),
      );
    }).toThrow(UnshownLinesEditError);
  });
});

describe('recordToolTurn', () => {
  it('keeps only the lines a read showed', () => {
    expect(recordToolTurn(read('refs.bib', bib, { first: 3, last: 4 }))).toEqual({
      tool: 'read_file',
      path: 'refs.bib',
      shown: { first: 3, last: 4 },
      totalLines: 10,
      lines: ['line 2', 'line 3'],
    });
  });

  it('keeps the query of a search with its matches', () => {
    expect(
      recordToolTurn({
        kind: 'tool',
        call: { tool: 'search', query: 'fig' },
        result: { tool: 'search', matches: [], truncated: true },
      }),
    ).toEqual({ tool: 'search', query: 'fig', matches: [], truncated: true });
  });
});

describe('createReadRecord', () => {
  it('rejects lines that do not fit the range', () => {
    expect(() => createReadRecord('a.tex', { first: 1, last: 2 }, 5, ['x'])).toThrow(
      InvalidToolRecordError,
    );
    expect(() => createReadRecord('a.tex', { first: 4, last: 6 }, 5, ['x', 'y', 'z'])).toThrow(
      InvalidToolRecordError,
    );
  });

  it('records an empty file', () => {
    expect(createReadRecord('a.tex', { first: 1, last: 0 }, 0, [])).toMatchObject({ lines: [] });
  });
});
