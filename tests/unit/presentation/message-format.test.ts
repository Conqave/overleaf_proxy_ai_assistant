import { describe, expect, it } from 'vitest';
import type { ProposalMessage } from '../../../src/domain/conversation';
import {
  createDocumentCommand,
  type DocumentCommandInput,
} from '../../../src/domain/document-command';
import {
  appliedNotice,
  changeSetStatusText,
  conflictNotice,
  contextUsageText,
  editStatusText,
  messageMeta,
  messageTitle,
  delegationMeta,
  delegationTitle,
  progressStatus,
  sessionDetails,
  webResultSource,
  webSearchMeta,
  webSearchTitle,
} from '../../../src/presentation/message-format';
import { editWith, proposalOf } from '../../support/proposals';

const proposal = (input: DocumentCommandInput, path = 'chapters/a.tex'): ProposalMessage =>
  proposalOf('1', editWith(path, createDocumentCommand(input), 'proposed'));
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
  const replaced = {
    path: 'refs.bib',
    command: createDocumentCommand({ operation: 'replace', target, lineCount: 1, content: 'x' }),
  };
  const deleted = {
    path: 'main.tex',
    command: createDocumentCommand({ operation: 'delete', target, lineCount: 4 }),
  };

  it('reports how many lines of one edit changed in which file', () => {
    expect(appliedNotice({ applied: [replaced], conflicts: [] })).toBe(
      'Done. Line replaced in refs.bib.',
    );
    expect(appliedNotice({ applied: [deleted], conflicts: [] })).toBe(
      'Done. 4 lines deleted in main.tex.',
    );
  });

  it('counts the edits of several files and says nothing when none was applied', () => {
    expect(appliedNotice({ applied: [replaced, deleted, deleted], conflicts: [] })).toBe(
      'Done. Applied 3 edits in refs.bib, main.tex.',
    );
    expect(appliedNotice({ applied: [], conflicts: [] })).toBeUndefined();
  });
});

describe('conflictNotice', () => {
  it('names the file that was left unchanged and why', () => {
    expect(conflictNotice({ path: 'refs.bib', problem: 'It changed.' })).toBe(
      'Not applied in refs.bib: It changed.',
    );
  });
});

describe('edit statuses', () => {
  it.each([
    ['proposed', undefined],
    ['applied', 'Applied'],
    ['rejected', 'Rejected'],
    ['failed', 'Not applied'],
    ['discarded', 'Discarded'],
  ] as const)('labels a %s edit', (status, text) => {
    expect(editStatusText(status)).toBe(text);
  });

  it('labels a change by its shared status or counts its statuses', () => {
    const command = createDocumentCommand({ operation: 'delete', target });
    const of = (...statuses: ('proposed' | 'applied' | 'rejected')[]) =>
      statuses.map((status) => editWith('main.tex', command, status));
    expect(changeSetStatusText(of('applied', 'applied'))).toBe('Applied');
    expect(changeSetStatusText(of('proposed', 'proposed'))).toBeUndefined();
    expect(changeSetStatusText(of('proposed', 'rejected', 'applied', 'applied'))).toBe(
      '2 applied · 1 rejected · 1 open',
    );
  });
});

describe('messageTitle', () => {
  it('names the operation of one edit and counts the edits and files of a change', () => {
    const command = createDocumentCommand({ operation: 'delete', target });
    expect(messageTitle(proposalOf('1', editWith('a.tex', command, 'proposed')))).toBe(
      'Proposed deletion',
    );
    const edits = ['a.tex', 'a.tex', 'b.tex'].map((path) => editWith(path, command, 'proposed'));
    expect(messageTitle(proposalOf('2', ...edits))).toBe('Proposed changes: 3 edits in 2 files');
  });
});

describe('contextUsageText', () => {
  it('shows the prompt and the context window in thousands of tokens', () => {
    expect(
      contextUsageText({
        contextTokens: 98_304,
        promptTokens: 12_345,
        pressure: 'low',
      }),
    ).toBe('Context 12.3k / 98.3k');
  });

  it('shows an unused context window as zero', () => {
    expect(contextUsageText({ contextTokens: 98_304, promptTokens: 0, pressure: 'low' })).toBe(
      'Context 0 / 98.3k',
    );
  });
});

describe('progressStatus', () => {
  it.each([
    [{ stage: 'thinking', step: 2 } as const, 'Hans is thinking'],
    [{ stage: 'reading', path: 'sample.bib' } as const, 'Hans is reading sample.bib'],
    [{ stage: 'searching', query: '\\label{fig}' } as const, 'Hans is searching for \\label{fig}'],
    [{ stage: 'compiling' } as const, 'Hans is compiling the project'],
    [
      {
        stage: 'awaiting-approval',
        search: { id: 'a', query: 'LaTeX DOI', autoApprovalScopes: [] },
      } as const,
      'Hans is waiting for your approval of a web search',
    ],
    [
      { stage: 'searching-web', query: 'LaTeX DOI' } as const,
      'Hans is searching the web for LaTeX DOI',
    ],
    [{ stage: 'opening', path: 'refs.bib' } as const, 'Hans is opening refs.bib'],
    [
      { stage: 'delegating', task: 'Check keys', fileCount: 12 } as const,
      'Hans: subagent reviewing 12 files…',
    ],
    [
      { stage: 'subagent', fileCount: 1, progress: { stage: 'thinking', step: 1 } } as const,
      'Hans: subagent reviewing 1 file…',
    ],
    [
      { stage: 'subagent', fileCount: 3, progress: { stage: 'reading', path: 'a.tex' } } as const,
      'Hans: subagent reviewing 3 files… reading a.tex',
    ],
    [
      {
        stage: 'subagent',
        fileCount: 3,
        progress: { stage: 'searching', query: '\\cite{' },
      } as const,
      'Hans: subagent reviewing 3 files… searching for \\cite{',
    ],
  ])('describes %o', (progress, text) => {
    expect(progressStatus(progress)).toBe(text);
  });

  it('keeps the status while only the context use or the records change', () => {
    const contextUsage = { contextTokens: 98_304, promptTokens: 10, pressure: 'low' } as const;
    expect(progressStatus({ stage: 'measured', contextUsage })).toBeNull();
    expect(
      progressStatus({
        stage: 'subagent',
        fileCount: 2,
        progress: { stage: 'measured', contextUsage },
      }),
    ).toBeNull();
  });
});

describe('delegation card text', () => {
  const record = {
    tool: 'delegate',
    task: 'Check keys',
    files: ['a.tex', 'b.bib'],
    report: { outcome: 'finished', text: 'ok', truncated: true, lookups: 1 },
  } as const;

  it('names the task, the lookups, the files and a cut result', () => {
    expect(delegationTitle(record)).toBe('Subagent result: Check keys');
    expect(delegationMeta(record)).toBe('1 lookup · files: a.tex, b.bib · cut at the length limit');
  });

  it('says when the subagent stopped', () => {
    const failed = {
      ...record,
      files: [],
      report: { outcome: 'failed', problem: 'p', lookups: 4 },
    } as const;
    expect(delegationTitle(failed)).toBe('Subagent stopped: Check keys');
    expect(delegationMeta(failed)).toBe('4 lookups');
  });
});

describe('web search card text', () => {
  const found = (truncated: boolean, count: number) => ({
    tool: 'web_search' as const,
    query: 'LaTeX DOI',
    outcome: {
      status: 'found' as const,
      results: Array.from({ length: count }, (_, index) => ({
        title: `T${String(index)}`,
        url: `https://example.org/${String(index)}`,
        snippet: '',
      })),
      truncated,
    },
  });

  it('names the query and how the search ended', () => {
    expect(webSearchTitle(found(false, 1))).toBe('Web search: LaTeX DOI');
    expect(
      webSearchTitle({ tool: 'web_search', query: 'LaTeX DOI', outcome: { status: 'denied' } }),
    ).toBe('Web search denied: LaTeX DOI');
    expect(
      webSearchTitle({
        tool: 'web_search',
        query: 'LaTeX DOI',
        outcome: { status: 'failed', problem: 'down' },
      }),
    ).toBe('Web search failed: LaTeX DOI');
  });

  it('counts the results and says when their excerpts were shortened', () => {
    expect(webSearchMeta(found(false, 1))).toBe('1 result');
    expect(webSearchMeta(found(true, 5))).toBe('5 results · excerpts shortened');
    expect(webSearchMeta(found(false, 0))).toBe('No results');
    expect(
      webSearchMeta({ tool: 'web_search', query: 'LaTeX DOI', outcome: { status: 'denied' } }),
    ).toBeUndefined();
  });

  it('shows the host and the date of a result', () => {
    const result = { title: 'T', url: 'https://dl.acm.org/doi/10.5555/63364', snippet: '' };
    expect(webResultSource(result)).toBe('dl.acm.org');
    expect(webResultSource({ ...result, published: '1986' })).toBe('dl.acm.org · 1986');
  });
});

describe('sessionDetails', () => {
  const summary = { id: 's', title: 'Add a table', createdAt: 0, messageCount: 1 };
  const updatedAt = Date.UTC(2026, 9, 1, 12, 0);

  it('shows when the session last changed and how many messages it has', () => {
    expect(sessionDetails({ ...summary, updatedAt, messageCount: 4 })).toMatch(
      /2026.* · 4 messages$/,
    );
  });

  it('counts a single message in the singular', () => {
    expect(sessionDetails({ ...summary, updatedAt })).toMatch(/ · 1 message$/);
  });
});
