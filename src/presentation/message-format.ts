import type { AgentProgress, ApplyReport, FileConflict } from '../application/agent-progress';
import type { ContextUsage } from '../application/handle-assistant-request';
import { EditStatus, type EditRequest, type ProposedEdit } from '../domain/change-set';
import type {
  AssistantMessage,
  CompactionSummaryMessage,
  UndoMessage,
  UndoRefusal,
} from '../domain/conversation';
import type { DelegateRecord } from '../domain/agent-transcript';
import { DelegationOutcome } from '../domain/delegation';
import { DocumentOperation, type DocumentCommand } from '../domain/document-command';
import type { SessionSummary } from '../domain/session';
import { SESSION_EXPORT_FOLDER } from '../domain/session-export';
import { PATH_SEPARATOR } from '../domain/project-file';

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
  welcomeTitle: 'Ready to help with this document',
  welcomeCopy:
    'Ask for an explanation, a cleaner paragraph, or a precise LaTeX edit. I will show a suggestion before changing anything.',
} as const;

export const COMPILED = 'Compiled without errors.';
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
};

const EDIT_STATUS_COUNT: Record<EditStatus, string> = {
  [EditStatus.Proposed]: 'open',
  [EditStatus.Applied]: 'applied',
  [EditStatus.Rejected]: 'rejected',
  [EditStatus.Failed]: 'not applied',
  [EditStatus.Discarded]: 'discarded',
  [EditStatus.Undone]: 'undone',
};

const STATUS_COUNT_ORDER: readonly EditStatus[] = [
  EditStatus.Applied,
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
    case DocumentOperation.InsertAfter:
      return `anchor line ${first}: ${lineText}`;
    case DocumentOperation.Replace:
    case DocumentOperation.Delete:
      if (command.lineCount === 1) return `line ${first}: ${lineText}`;
      return `lines ${first}–${String(lineNumber + command.lineCount - 1)}, starting: ${lineText}`;
  }
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

export function exportedNotice(path: string): string {
  return `Exported to ${path}. Collaborators can import it after reloading the project.`;
}

export function importedNotice(path: string): string {
  return `Imported ${path} as a new session of yours; edits it left open were discarded.`;
}

export function exportFileName(path: string): string {
  return path.slice(path.lastIndexOf(PATH_SEPARATOR) + 1);
}

export function errorNotice(message: string): string {
  return `Error: ${message}`;
}

export function appliedNotice({ applied }: ApplyReport): string | undefined {
  const [only] = applied;
  if (only === undefined) return undefined;
  if (applied.length === 1) return singleEditNotice(only);
  const paths = [...new Set(applied.map(({ path }) => path))];
  return `Done. Applied ${countOf(applied.length, 'edit')} in ${paths.join(', ')}.`;
}

function singleEditNotice({ path, command }: EditRequest): string {
  switch (command.operation) {
    case DocumentOperation.InsertBefore:
      return `Done. Inserted before the selected anchor in ${path}.`;
    case DocumentOperation.InsertAfter:
      return `Done. Inserted after the selected anchor in ${path}.`;
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
  return `Undone: ${undone.join(', ')} ${undone.length === 1 ? 'is' : 'are'} back as before this change.`;
}

export function undoRefusalNotice({ path, problem }: UndoRefusal): string {
  return `Not undone in ${path}: ${problem}`;
}

export function conflictNotice({ path, problem }: FileConflict): string {
  return `Not applied in ${path}: ${problem}`;
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
    case 'delegating':
      return subagentReviewing(progress.fileCount);
    case 'subagent':
      return subagentStatus(progress.fileCount, progress.progress);
    case 'opening':
      return `Hans is opening ${progress.path}`;
    case 'compacting':
      return 'Hans is summarising the earlier conversation';
    case 'decided':
    case 'applied':
    case 'compacted':
      return '';
    case 'measured':
    case 'recorded':
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
    case 'delegating':
    case 'subagent':
    case 'recorded':
    case 'opening':
    case 'decided':
    case 'applied':
    case 'compacting':
    case 'compacted':
      return null;
  }
}
