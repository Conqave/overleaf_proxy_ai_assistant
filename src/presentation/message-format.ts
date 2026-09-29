import type { Evidence } from '../domain/assistant-plan';
import type { AssistantMessage } from '../domain/conversation';
import { DocumentOperation, type DocumentCommand } from '../domain/document-command';
import type { RequestProgress } from '../application/handle-assistant-request';

const KIND_TITLE: Record<Exclude<AssistantMessage['kind'], 'proposal'>, string> = {
  greeting: 'Hi, I am here',
  summary: 'Document summary',
  explanation: 'Explanation',
  clarification: 'Hans needs a little more detail',
};

const PROPOSAL_TITLE: Record<DocumentOperation, string> = {
  [DocumentOperation.InsertBefore]: 'Proposed insertion',
  [DocumentOperation.InsertAfter]: 'Proposed insertion',
  [DocumentOperation.Replace]: 'Proposed replacement',
  [DocumentOperation.Delete]: 'Proposed deletion',
};

const NEED_STATUS: Record<Evidence, string> = {
  line_context: 'Hans is reading the nearby lines',
  selection: 'Hans is reading the selected text',
  logs: 'Hans is reading the logs',
};

const DOCUMENT_STATUS = 'Hans is reading the TeX content';

const STATUS_LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

export const GREETING = 'Tell me what to change, explain, or fix in this Overleaf document.';
export const REJECTED = 'Change rejected.';
export const INTERNAL_ERROR = 'Unexpected internal error. Details are in the browser console.';

export function messageTitle(message: AssistantMessage): string {
  if (message.kind !== 'proposal') return KIND_TITLE[message.kind];
  return PROPOSAL_TITLE[message.command.operation];
}

export function messageMeta(message: AssistantMessage): string | undefined {
  if (message.kind !== 'proposal') return undefined;
  const { command } = message;
  const { lineNumber, lineText } = command.target;
  const first = String(lineNumber);
  switch (command.operation) {
    case DocumentOperation.InsertBefore:
    case DocumentOperation.InsertAfter:
      return `Anchor: line ${first}: ${lineText}`;
    case DocumentOperation.Replace:
    case DocumentOperation.Delete:
      if (command.lineCount === 1) return `Line ${first}: ${lineText}`;
      return `Lines ${first}–${String(lineNumber + command.lineCount - 1)}, starting: ${lineText}`;
  }
}

export function appliedNotice(command: DocumentCommand): string {
  switch (command.operation) {
    case DocumentOperation.InsertBefore:
      return 'Done. Inserted before the selected anchor.';
    case DocumentOperation.InsertAfter:
      return 'Done. Inserted after the selected anchor.';
    case DocumentOperation.Replace:
      return command.lineCount === 1
        ? 'Done. Line replaced.'
        : `Done. ${String(command.lineCount)} lines replaced.`;
    case DocumentOperation.Delete:
      return command.lineCount === 1
        ? 'Done. Line deleted.'
        : `Done. ${String(command.lineCount)} lines deleted.`;
  }
}

export function progressStatus(progress: RequestProgress): string {
  switch (progress.stage) {
    case 'received':
    case 'planning':
      return 'Hans is reading what it needs first.';
    case 'answering': {
      const parts = progress.plan.needs.map((need) => NEED_STATUS[need]);
      return STATUS_LIST.format([DOCUMENT_STATUS, ...parts]);
    }
  }
}
