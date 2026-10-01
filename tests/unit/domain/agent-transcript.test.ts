import { describe, expect, it } from 'vitest';
import { getShownDocument, type AgentTurn } from '../../../src/domain/agent-transcript';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { UnreadFileEditError } from '../../../src/domain/errors';

const open = { path: 'main.tex', document: createDocumentSnapshot(['open']) };

function read(path: string, line: string): AgentTurn {
  return {
    kind: 'tool',
    call: { tool: 'read_file', path },
    result: { tool: 'read_file', path, document: createDocumentSnapshot([line]) },
  };
}

describe('getShownDocument', () => {
  it('gives the open file as shown in the workspace', () => {
    expect(getShownDocument(open, [], 'main.tex')).toBe(open.document);
  });

  it('gives the latest read of another file', () => {
    const shown = getShownDocument(
      open,
      [read('refs.bib', 'old'), read('refs.bib', 'new')],
      'refs.bib',
    );
    expect(shown.lines).toEqual(['new']);
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
