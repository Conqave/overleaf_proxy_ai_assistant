import type { AgentProgress } from '../application/agent-progress';
import type { ContextUsage } from '../application/handle-assistant-request';
import type { ProjectEdit } from '../domain/agent-action';
import type { AssistantMessage } from '../domain/conversation';
import { DocumentOperation } from '../domain/document-command';

const KIND_TITLE: Record<Exclude<AssistantMessage['kind'], 'proposal'>, string> = {
  greeting: 'Hi, I am here',
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
  newChatHint: 'Start a new chat',
  inputLabel: 'Command',
  inputPlaceholder:
    'Describe what you want: explain an error, improve text, insert a table or delete a line.',
  send: 'Send',
  apply: 'Apply',
  reject: 'Reject',
  contextHint: 'Tokens of the last prompt sent to the model / context window of the model',
  welcomeTitle: 'Ready to help with this document',
  welcomeCopy:
    'Ask for an explanation, a cleaner paragraph, or a precise LaTeX edit. I will show a suggestion before changing anything.',
} as const;

export const GREETING = 'Tell me what to change, explain, or fix in this Overleaf document.';
export const REJECTED = 'Change rejected.';
export const COMPILED = 'Compiled without errors.';
export const INTERNAL_ERROR = 'Unexpected internal error. Details are in the browser console.';

export function messageTitle(message: AssistantMessage): string {
  if (message.kind !== 'proposal') return KIND_TITLE[message.kind];
  return PROPOSAL_TITLE[message.command.operation];
}

export function messageMeta(message: AssistantMessage): string | undefined {
  if (message.kind !== 'proposal') return undefined;
  const { command, path } = message;
  const { lineNumber, lineText } = command.target;
  const first = String(lineNumber);
  switch (command.operation) {
    case DocumentOperation.InsertBefore:
    case DocumentOperation.InsertAfter:
      return `${path}, anchor line ${first}: ${lineText}`;
    case DocumentOperation.Replace:
    case DocumentOperation.Delete:
      if (command.lineCount === 1) return `${path}, line ${first}: ${lineText}`;
      return `${path}, lines ${first}–${String(lineNumber + command.lineCount - 1)}, starting: ${lineText}`;
  }
}

export function errorNotice(message: string): string {
  return `Error: ${message}`;
}

export function appliedNotice({ file, edit }: ProjectEdit): string {
  const { path } = file;
  const { command } = edit;
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

export function contextUsageText({ promptTokens, contextTokens }: ContextUsage): string {
  return `Context ${thousands(promptTokens)} / ${thousands(contextTokens)}`;
}

function thousands(tokens: number): string {
  return `${(tokens / TOKENS_PER_THOUSAND).toFixed(1)}k`;
}

export function progressStatus(progress: AgentProgress): string {
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
    case 'opening':
      return `Hans is opening ${progress.path}`;
    case 'applied':
      return 'Hans applied the change';
  }
}
