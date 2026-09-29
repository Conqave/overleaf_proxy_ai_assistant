import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '../../../src/domain/conversation';
import {
  createDocumentCommand,
  type DocumentCommandInput,
} from '../../../src/domain/document-command';
import { appliedNotice, messageMeta } from '../../../src/presentation/message-format';

const proposal = (input: DocumentCommandInput): AssistantMessage => ({
  id: '1',
  role: 'assistant',
  kind: 'proposal',
  command: createDocumentCommand(input),
  plan: '',
});
const target = { lineNumber: 3, lineText: '\\section{A}' };

describe('messageMeta', () => {
  it('names the anchor of an insertion', () => {
    expect(messageMeta(proposal({ operation: 'insert_after', target, content: 'x' }))).toBe(
      'Anchor: line 3: \\section{A}',
    );
  });

  it('names the line or the range of a replacement or deletion', () => {
    expect(messageMeta(proposal({ operation: 'delete', target, lineCount: 1 }))).toBe(
      'Line 3: \\section{A}',
    );
    expect(
      messageMeta(proposal({ operation: 'replace', target, lineCount: 3, content: 'x' })),
    ).toBe('Lines 3–5, starting: \\section{A}');
  });
});

describe('appliedNotice', () => {
  it('reports how many lines were replaced or deleted', () => {
    const replaced = createDocumentCommand({
      operation: 'replace',
      target,
      lineCount: 1,
      content: 'x',
    });
    const deleted = createDocumentCommand({ operation: 'delete', target, lineCount: 4 });
    expect(appliedNotice(replaced)).toBe('Done. Line replaced.');
    expect(appliedNotice(deleted)).toBe('Done. 4 lines deleted.');
  });
});
