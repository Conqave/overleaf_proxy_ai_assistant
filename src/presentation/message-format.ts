import type { AgentProgress } from '../application/agent-progress';
import type { ContextUsage } from '../domain/context-usage';
import { AutoApprovalScope } from '../application/web-search-approval';
import { EditStatus, type EditRequest, type ProposedEdit } from '../domain/change-set';
import type {
  AssistantMessage,
  CompactionSummaryMessage,
  UndoMessage,
  UndoRefusal,
  Notice,
} from '../domain/conversation';
import type { DelegateRecord, WebSearchRecord } from '../domain/agent-transcript';
import { DelegationOutcome } from '../domain/delegation';
import { InvariantViolation } from '../domain/errors';
import { DocumentOperation, type DocumentCommand } from '../domain/document-command';
import type { SessionSummary } from '../domain/session';
import { SESSION_EXPORT_FOLDER } from '../domain/session-export';
import { PATH_SEPARATOR } from '../domain/project-file';
import { WebSearchStatus, type WebSearchResult } from '../domain/web-search';

const KIND_TITLE: Record<Exclude<AssistantMessage['kind'], 'proposal'>, string> = {
  explanation: 'Explanation',
  clarification: 'Hans needs a little more detail',
};

const PROPOSAL_TITLE: Record<DocumentOperation, string> = {
  [DocumentOperation.InsertBefore]: 'Proposed insertion',
  [DocumentOperation.InsertAfter]: 'Proposed insertion',
  [DocumentOperation.Replace]: 'Proposed replacement',
  [DocumentOperation.Delete]: 'Proposed deletion',
};

const TOKENS_PER_THOUSAND = 1_000;

export const AUTO_APPROVAL_TEXT: Record<AutoApprovalScope, string> = {
  [AutoApprovalScope.Request]: 'Auto-approve for this request',
  [AutoApprovalScope.Session]: 'Auto-approve for this session',
};

export const VIEW_TEXT = {
  badge: 'Hans',
  title: 'Hans AI Assistant',
  newChat: 'New',
  newChatHint: 'Start a new session; the current one stays saved',
  sessions: 'Sessions',
  sessionsHint: 'Show the saved sessions of this project',
  sessionsTitle: 'Sessions of this project',
  noSessions: 'No saved sessions in this project yet.',
  currentSession: 'Current',
  openSessionHint: 'Open this session',
  deleteSession: 'Delete',
  deleteSessionHint: 'Delete this session from this browser',
  confirmDeleteSession: 'Delete this session?',
  cancelDeleteSession: 'Cancel',
  unreadableSession: 'Unreadable session',
  exportSession: 'Export',
  exportSessionHint: `Save this session as a file in ${SESSION_EXPORT_FOLDER}/ of the project so collaborators can import it`,
  showImports: 'Import',
  showImportsHint: 'Import a session that someone exported into this project',
  importsTitle: `Exported sessions in ${SESSION_EXPORT_FOLDER}/`,
  noImports: `No sessions have been exported to ${SESSION_EXPORT_FOLDER}/ yet.`,
  importsReloadHint: 'Sessions exported after this page loaded appear after reloading Overleaf.',
  importSession: 'Import',
  importSessionHint:
    'Add this session to your sessions and open it; the project file stays as it is',
  compact: 'Compact',
  compactHint: 'Compact context now: summarise the earlier conversation',
  inputLabel: 'Command',
  inputPlaceholder:
    'Describe what you want: explain an error, improve text, insert a table or delete a line.',
  send: 'Send',
  apply: 'Apply',
  reject: 'Reject',
  applyAll: 'Apply all',
  rejectAll: 'Reject all',
  showFile: 'Show in editor',
  showFileHint: 'Open this file and preview its open edits',
  undo: 'Undo this turn',
  undoHint: 'Take back every edit Hans applied in this change',
  resizeLabel: 'Resize the Hans panel',
  resizeHint: 'Drag to resize; arrow keys change width and height, Shift for larger steps',
  contextHint: 'Tokens of the last prompt sent to the model / context window of the model',
  approvalTitle: 'Hans wants to search the web',
  approvalNote: 'Exa (exa.ai), an external search service, receives this query.',
  approve: 'Approve',
  deny: 'Deny',
  autoApprovalNote: 'Auto-approval ends once web results or imported messages are in its scope.',
  welcomeTitle: 'Ready to help with this document',
  welcomeCopy:
    'Ask for an explanation, a cleaner paragraph, or a precise LaTeX edit. I will show a suggestion before changing anything.',
} as const;

const COMPILED = 'Compiled without errors.';

function compiledWithErrorsNotice(errorCount: number): string {
  return `Compiled with ${countOf(errorCount, 'error')}; see the PDF pane for details.`;
}
export const INTERNAL_ERROR = 'Unexpected internal error. Details are in the browser console.';

export function messageTitle(message: AssistantMessage): string {
  if (message.kind !== 'proposal') return KIND_TITLE[message.kind];
  const [only] = message.edits;
  if (only !== undefined && message.edits.length === 1)
    return PROPOSAL_TITLE[only.command.operation];
  const files = new Set(message.edits.map(({ path }) => path)).size;
  return `Proposed changes: ${countOf(message.edits.length, 'edit')} in ${countOf(files, 'file')}`;
}

const EDIT_STATUS_TEXT: Record<EditStatus, string | undefined> = {
  [EditStatus.Proposed]: undefined,
  [EditStatus.Applied]: 'Applied',
  [EditStatus.Rejected]: 'Rejected',
  [EditStatus.Failed]: 'Not applied',
  [EditStatus.Discarded]: 'Discarded',
  [EditStatus.Undone]: 'Undone',
  [EditStatus.AppliedBeforeImport]: 'Applied before the import',
};

const EDIT_STATUS_COUNT: Record<EditStatus, string> = {
  [EditStatus.Proposed]: 'open',
  [EditStatus.Applied]: 'applied',
  [EditStatus.Rejected]: 'rejected',
  [EditStatus.Failed]: 'not applied',
  [EditStatus.Discarded]: 'discarded',
  [EditStatus.Undone]: 'undone',
  [EditStatus.AppliedBeforeImport]: 'applied before the import',
};

const STATUS_COUNT_ORDER: readonly EditStatus[] = [
  EditStatus.Applied,
  EditStatus.AppliedBeforeImport,
  EditStatus.Rejected,
  EditStatus.Failed,
  EditStatus.Discarded,
  EditStatus.Undone,
  EditStatus.Proposed,
];

export function editStatusText(status: EditStatus): string | undefined {
  return EDIT_STATUS_TEXT[status];
}

export function getSharedStatus(edits: readonly ProposedEdit[]): EditStatus | null {
  const statuses = new Set(edits.map(({ status }) => status));
  const [shared] = statuses;
  return statuses.size === 1 && shared !== undefined ? shared : null;
}

export function changeSetStatusText(edits: readonly ProposedEdit[]): string | undefined {
  const shared = getSharedStatus(edits);
  if (shared !== null) return editStatusText(shared);
  return STATUS_COUNT_ORDER.map((status) => ({
    status,
    count: edits.filter((edit) => edit.status === status).length,
  }))
    .filter(({ count }) => count > 0)
    .map(({ status, count }) => `${String(count)} ${EDIT_STATUS_COUNT[status]}`)
    .join(' · ');
}

export function messageMeta(message: AssistantMessage): string | undefined {
  if (message.kind !== 'proposal') return undefined;
  const [only] = message.edits;
  if (only === undefined || message.edits.length > 1) return undefined;
  return `${only.path}, ${editLinesMeta(only.command)}`;
}

export function editLinesMeta(command: DocumentCommand): string {
  const { lineNumber, lineText } = command.target;
  const first = String(lineNumber);
  switch (command.operation) {
    case DocumentOperation.InsertBefore:
      return `before ${quotedLine(`line ${first}`, lineText)}`;
    case DocumentOperation.InsertAfter:
      return `after ${quotedLine(`line ${first}`, lineText)}`;
    case DocumentOperation.Replace:
    case DocumentOperation.Delete:
      if (command.lineCount === 1) return quotedLine(`line ${first}`, lineText);
      return quotedLine(
        `lines ${first}–${String(lineNumber + command.lineCount - 1)}, starting`,
        lineText,
      );
  }
}

function quotedLine(place: string, lineText: string): string {
  return lineText.trim() === '' ? `${place} (empty line)` : `${place}: ${lineText}`;
}

function countOf(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${String(count)} ${noun}s`;
}

const SESSION_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function sessionDetails({ updatedAt, messageCount }: SessionSummary): string {
  const count = messageCount === 1 ? '1 message' : `${String(messageCount)} messages`;
  return `${SESSION_DATE_FORMAT.format(updatedAt)} · ${count}`;
}

function exportedNotice(path: string): string {
  return `Exported to ${path}. Collaborators can import it after reloading the project.`;
}

function importedNotice(path: string): string {
  return `Imported ${path} as a new session of yours; edits it left open were discarded.`;
}

export function exportFileName(path: string): string {
  return path.slice(path.lastIndexOf(PATH_SEPARATOR) + 1);
}

function errorNotice(message: string): string {
  return `Error: ${message}`;
}

export type NoticeTone = 'info' | 'error';

export interface NoticeText {
  readonly text: string;
  readonly tone: NoticeTone;
}

export function noticeText(notice: Notice): NoticeText {
  switch (notice.kind) {
    case 'applied':
      return { text: appliedNotice(notice.applied), tone: 'info' };
    case 'conflict':
      return { text: `Not applied in ${notice.path}: ${notice.problem}`, tone: 'error' };
    case 'compiled':
      return notice.errorCount === 0
        ? { text: COMPILED, tone: 'info' }
        : { text: compiledWithErrorsNotice(notice.errorCount), tone: 'error' };
    case 'exported':
      return { text: exportedNotice(notice.path), tone: 'info' };
    case 'imported':
      return { text: importedNotice(notice.path), tone: 'info' };
    case 'failed':
      return { text: errorNotice(notice.problem), tone: 'error' };
  }
}

function appliedNotice(applied: readonly EditRequest[]): string {
  const [only] = applied;
  if (only === undefined) throw new InvariantViolation('an applied notice names no edit');
  if (applied.length === 1) return singleEditNotice(only);
  const paths = [...new Set(applied.map(({ path }) => path))];
  return `Done. Applied ${countOf(applied.length, 'edit')} in ${paths.join(', ')}.`;
}

function singleEditNotice({ path, command }: EditRequest): string {
  switch (command.operation) {
    case DocumentOperation.InsertBefore:
      return `Done. Inserted before line ${String(command.target.lineNumber)} in ${path}.`;
    case DocumentOperation.InsertAfter:
      return `Done. Inserted after line ${String(command.target.lineNumber)} in ${path}.`;
    case DocumentOperation.Replace:
      return command.lineCount === 1
        ? `Done. Line replaced in ${path}.`
        : `Done. ${String(command.lineCount)} lines replaced in ${path}.`;
    case DocumentOperation.Delete:
      return command.lineCount === 1
        ? `Done. Line deleted in ${path}.`
        : `Done. ${String(command.lineCount)} lines deleted in ${path}.`;
  }
}

export function undoNotice({ undone }: UndoMessage): string {
  if (undone.length === 0) return 'Nothing was undone.';
  return `Undone in ${undone.join(', ')}: the edits of this change were taken back; other edits stay.`;
}

export function undoRefusalNotice({ path, problem }: UndoRefusal): string {
  return `Not undone in ${path}: ${problem}`;
}

export function contextUsageText({ promptTokens, contextTokens }: ContextUsage): string {
  return `Context ${thousands(promptTokens)} / ${thousands(contextTokens)}`;
}

function thousands(tokens: number): string {
  if (tokens === 0) return '0';
  return `${(tokens / TOKENS_PER_THOUSAND).toFixed(1)}k`;
}

export function compactionNotice({
  tokensBefore,
  tokensAfter,
  coveredTurns,
}: CompactionSummaryMessage): string {
  const turns = coveredTurns === 1 ? '1 turn' : `${String(coveredTurns)} turns`;
  return `Context compacted: ${thousands(tokensBefore)} → ${thousands(tokensAfter)} (summary of ${turns})`;
}

export function compactionFiles({ files }: CompactionSummaryMessage): string {
  const listed = (paths: readonly string[]): string => (paths.length ? paths.join(', ') : 'none');
  return `Files read: ${listed(files.read)}. Files edited: ${listed(files.edited)}.`;
}

export function delegationTitle({ task, report }: DelegateRecord): string {
  switch (report.outcome) {
    case DelegationOutcome.Finished:
      return `Subagent result: ${task}`;
    case DelegationOutcome.Failed:
      return `Subagent stopped: ${task}`;
  }
}

export function delegationMeta({ files, report }: DelegateRecord): string {
  const parts = [countOf(report.lookups, 'lookup')];
  if (files.length) parts.push(`files: ${files.join(', ')}`);
  if (report.outcome === DelegationOutcome.Finished && report.truncated) {
    parts.push('cut at the length limit');
  }
  return parts.join(' · ');
}

export function webSearchTitle({ query, outcome }: WebSearchRecord): string {
  switch (outcome.status) {
    case WebSearchStatus.Found:
      return `Web search: ${query}`;
    case WebSearchStatus.Denied:
      return `Web search denied: ${query}`;
    case WebSearchStatus.Failed:
      return `Web search failed: ${query}`;
  }
}

export function webSearchMeta({ outcome }: WebSearchRecord): string | undefined {
  if (outcome.status !== WebSearchStatus.Found) return undefined;
  const found = outcome.results.length ? countOf(outcome.results.length, 'result') : 'No results';
  return outcome.truncated ? `${found} · excerpts shortened` : found;
}

export function webResultSource({ url, published }: WebSearchResult): string {
  const { host } = new URL(url);
  return published === undefined ? host : `${host} · ${published}`;
}

export function progressStatus(progress: AgentProgress): string | null {
  switch (progress.stage) {
    case 'received':
    case 'thinking':
      return 'Hans is thinking';
    case 'reading':
      return `Hans is reading ${progress.path}`;
    case 'searching':
      return `Hans is searching for ${progress.query}`;
    case 'compiling':
      return 'Hans is compiling the project';
    case 'awaiting-approval':
      return 'Hans is waiting for your approval of a web search';
    case 'searching-web':
      return `Hans is searching the web for ${progress.query}`;
    case 'delegating':
      return subagentReviewing(progress.fileCount);
    case 'subagent':
      return subagentStatus(progress.fileCount, progress.progress);
    case 'opening':
      return `Hans is opening ${progress.path}`;
    case 'compacting':
      return 'Hans is summarising the earlier conversation';
    case 'decided':
    case 'noted':
    case 'compacted':
      return '';
    case 'measured':
    case 'recorded':
    case 'approval-decided':
      return null;
  }
}

function subagentReviewing(fileCount: number): string {
  return `Hans: subagent reviewing ${countOf(fileCount, 'file')}…`;
}

function subagentStatus(fileCount: number, progress: AgentProgress): string | null {
  switch (progress.stage) {
    case 'thinking':
      return subagentReviewing(fileCount);
    case 'reading':
      return `${subagentReviewing(fileCount)} reading ${progress.path}`;
    case 'searching':
      return `${subagentReviewing(fileCount)} searching for ${progress.query}`;
    case 'received':
    case 'measured':
    case 'compiling':
    case 'awaiting-approval':
    case 'approval-decided':
    case 'searching-web':
    case 'delegating':
    case 'subagent':
    case 'recorded':
    case 'opening':
    case 'decided':
    case 'noted':
    case 'compacting':
    case 'compacted':
      return null;
  }
}
