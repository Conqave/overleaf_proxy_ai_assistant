import { describe, expect, it } from 'vitest';
import { AGENT_POLICY } from '../../../src/domain/agent-policy';
import { createDocumentSnapshot } from '../../../src/domain/document';
import { searchProject } from '../../../src/domain/project-search';

describe('searchProject', () => {
  it('finds lines case-insensitively across files', () => {
    const outcome = searchProject(
      [
        { path: 'main.tex', document: createDocumentSnapshot(['\\cite{Knuth84}', 'text']) },
        { path: 'refs.bib', document: createDocumentSnapshot(['@book{knuth84,']) },
      ],
      'KNUTH84',
    );
    expect(outcome).toEqual({
      matches: [
        { path: 'main.tex', lineNumber: 1, lineText: '\\cite{Knuth84}' },
        { path: 'refs.bib', lineNumber: 1, lineText: '@book{knuth84,' },
      ],
      truncated: false,
    });
  });

  it('caps the matches', () => {
    const lines = Array.from({ length: AGENT_POLICY.maxSearchMatches + 1 }, () => 'hit');
    const outcome = searchProject(
      [{ path: 'a.tex', document: createDocumentSnapshot(lines) }],
      'hit',
    );
    expect(outcome.matches).toHaveLength(AGENT_POLICY.maxSearchMatches);
    expect(outcome.truncated).toBe(true);
  });
});
