import { recordImportedEdits } from './change-set';
import { AssistantMessageKind, type ConversationMessage } from './conversation';
import { EmptySessionExportError, ForeignProjectExportError } from './errors';
import { PATH_SEPARATOR, type ProjectFile } from './project-file';
import {
  createSessionTitle,
  discardUndecidedProposals,
  type ConversationSession,
  type SessionScope,
} from './session';

export const SESSION_EXPORT_FOLDER = 'hans-sessions';
const IMPORTED_TITLE_PREFIX = 'Imported: ';
const EXPORT_EXTENSION = '.json';
const MAX_SLUG_LENGTH = 40;
const UNTITLED_SLUG = 'session';
const UNDECOMPOSED_LETTERS: readonly (readonly [string, string])[] = [
  ['ł', 'l'],
  ['đ', 'd'],
  ['ø', 'o'],
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['œ', 'oe'],
];

export interface ExportedSession {
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages: readonly ConversationMessage[];
}

export interface SessionExport {
  readonly projectId: string;
  readonly exportedBy: string;
  readonly exportedAt: number;
  readonly session: ExportedSession;
}

export function createSessionExport(
  session: ConversationSession,
  scope: SessionScope,
  exportedAt: number,
): SessionExport {
  return {
    projectId: scope.projectId,
    exportedBy: scope.userId,
    exportedAt,
    session: {
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages,
    },
  };
}

export function getSessionExportPath(
  exported: SessionExport,
  files: readonly ProjectFile[],
): string {
  const name = `${formatExportTime(new Date(exported.exportedAt))}-${slugOf(exported.session.title)}`;
  const taken = new Set(files.map(({ path }) => path));
  for (let copy = 1; ; copy += 1) {
    const suffix = copy === 1 ? '' : `-${String(copy)}`;
    const path = [SESSION_EXPORT_FOLDER, `${name}${suffix}${EXPORT_EXTENSION}`].join(
      PATH_SEPARATOR,
    );
    if (!taken.has(path)) return path;
  }
}

export function isSessionExportPath(path: string): boolean {
  const [folder, name, ...deeper] = path.split(PATH_SEPARATOR);
  return (
    folder === SESSION_EXPORT_FOLDER &&
    name !== undefined &&
    deeper.length === 0 &&
    name.endsWith(EXPORT_EXTENSION)
  );
}

export function listSessionExports(files: readonly ProjectFile[]): readonly ProjectFile[] {
  return files
    .filter((file) => isSessionExportPath(file.path))
    .sort((a, b) => b.path.localeCompare(a.path));
}

interface ImportTarget {
  readonly path: string;
  readonly scope: SessionScope;
  readonly id: string;
  readonly now: number;
}

export function importSessionExport(
  exported: SessionExport,
  { path, scope, id, now }: ImportTarget,
): ConversationSession {
  if (exported.projectId !== scope.projectId) {
    throw new ForeignProjectExportError(
      'This session was exported from another Overleaf project; import it in that project.',
    );
  }
  const { messages } = exported.session;
  const last = messages.at(-1);
  if (last === undefined) {
    throw new EmptySessionExportError(`${path} holds no messages; there is nothing to import.`);
  }
  return discardUndecidedProposals({
    id,
    title: createSessionTitle(`${IMPORTED_TITLE_PREFIX}${exported.session.title}`),
    createdAt: now,
    updatedAt: now,
    messages: messages.map(recordImportedMessage),
    imported: { path, lastMessageId: last.id },
    contextUsage: null,
  });
}

function recordImportedMessage(message: ConversationMessage): ConversationMessage {
  if (message.role !== 'assistant' || message.kind !== AssistantMessageKind.Proposal) {
    return message;
  }
  return { ...message, edits: recordImportedEdits(message.edits) };
}

function formatExportTime(time: Date): string {
  const date = [time.getFullYear(), time.getMonth() + 1, time.getDate()].map(twoDigits);
  const clock = [time.getHours(), time.getMinutes(), time.getSeconds()].map(twoDigits);
  return `${date.join('-')}-${clock.join('')}`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function slugOf(title: string): string {
  const letters = UNDECOMPOSED_LETTERS.reduce(
    (text, [letter, latin]) => text.replaceAll(letter, latin),
    title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase(),
  );
  const slug = letters
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug === '' ? UNTITLED_SLUG : slug;
}
