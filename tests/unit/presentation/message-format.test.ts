import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '../../../src/domain/conversation';
import { createDocumentSnapshot } from '../../../src/domain/document';
import {
  createDocumentCommand,
  type DocumentCommandInput,
} from '../../../src/domain/document-command';
import { ResolvedEdit } from '../../../src/domain/resolved-edit';
import {
  appliedNotice,
  messageMeta,
  progressStatus,
} from '../../../src/presentation/message-format';

const proposal = (input: DocumentCommandInput): AssistantMessage => ({
  id: '1',
  role: 'assistant',
  kind: 'proposal',
  path: 'chapters/a.tex',
  command: createDocumentCommand(input),
});
const target = { lineNumber: 3, lineText: '\\section{A}' };
const DOC = createDocumentSnapshot(['a', 'b', '\\section{A}', 'c', 'd', 'e']);

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
    const replaced = ResolvedEdit.resolve(
      DOC,
      createDocumentCommand({ operation: 'replace', target, lineCount: 1, content: 'x' }),
    );
    const deleted = ResolvedEdit.resolve(
      DOC,
      createDocumentCommand({ operation: 'delete', target, lineCount: 4 }),
    );
    expect(appliedNotice({ path: 'refs.bib', edit: replaced })).toBe(
      'Done. Line replaced in refs.bib.',
    );
    expect(appliedNotice({ path: 'main.tex', edit: deleted })).toBe(
      'Done. 4 lines deleted in main.tex.',
    );
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
