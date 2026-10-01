import { describe, expect, it } from 'vitest';
import type { ProposalMessage } from '../../../src/domain/conversation';
import {
  createDocumentCommand,
  type DocumentCommandInput,
} from '../../../src/domain/document-command';
import {
  appliedNotice,
  contextUsageText,
  messageMeta,
  progressStatus,
  proposalStatusText,
} from '../../../src/presentation/message-format';

const proposal = (input: DocumentCommandInput, path = 'chapters/a.tex'): ProposalMessage => ({
  id: '1',
  role: 'assistant',
  kind: 'proposal',
  path,
  command: createDocumentCommand(input),
  status: 'proposed',
});
const target = { lineNumber: 3, lineText: '\\section{A}' };

describe('messageMeta', () => {
  it('names the file and the anchor of an insertion', () => {
    expect(messageMeta(proposal({ operation: 'insert_after', target, content: 'x' }))).toBe(
      'chapters/a.tex, anchor line 3: \\section{A}',
    );
  });

  it('names the file and the line or the range of a replacement or deletion', () => {
    expect(messageMeta(proposal({ operation: 'delete', target, lineCount: 1 }))).toBe(
      'chapters/a.tex, line 3: \\section{A}',
    );
    expect(
      messageMeta(proposal({ operation: 'replace', target, lineCount: 3, content: 'x' })),
    ).toBe('chapters/a.tex, lines 3–5, starting: \\section{A}');
  });
});

describe('appliedNotice', () => {
  it('reports how many lines changed in which file', () => {
    const replaced = proposal(
      { operation: 'replace', target, lineCount: 1, content: 'x' },
      'refs.bib',
    );
    const deleted = proposal({ operation: 'delete', target, lineCount: 4 }, 'main.tex');
    expect(appliedNotice(replaced)).toBe('Done. Line replaced in refs.bib.');
    expect(appliedNotice(deleted)).toBe('Done. 4 lines deleted in main.tex.');
  });
});

describe('proposalStatusText', () => {
  it.each([
    ['proposed', undefined],
    ['applied', 'Applied'],
    ['rejected', 'Rejected'],
    ['failed', 'Not applied'],
    ['discarded', 'Discarded'],
  ] as const)('labels a %s proposal', (status, text) => {
    expect(proposalStatusText(status)).toBe(text);
  });
});

describe('contextUsageText', () => {
  it('shows the prompt and the context window in thousands of tokens', () => {
    expect(
      contextUsageText({
        contextTokens: 98_304,
        promptTokens: 12_345,
      }),
    ).toBe('Context 12.3k / 98.3k');
  });

  it('shows an unused context window as zero', () => {
    expect(contextUsageText({ contextTokens: 98_304, promptTokens: 0 })).toBe('Context 0 / 98.3k');
  });
});

describe('progressStatus', () => {
  it.each([
    [{ stage: 'thinking', step: 2 } as const, 'Hans is thinking'],
    [{ stage: 'reading', path: 'sample.bib' } as const, 'Hans is reading sample.bib'],
    [{ stage: 'searching', query: '\\label{fig}' } as const, 'Hans is searching for \\label{fig}'],
    [{ stage: 'compiling' } as const, 'Hans is compiling the project'],
    [{ stage: 'opening', path: 'refs.bib' } as const, 'Hans is opening refs.bib'],
  ])('describes %o', (progress, text) => {
    expect(progressStatus(progress)).toBe(text);
  });
});
