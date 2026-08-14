import type { Evidence } from '../domain/assistant-plan';
import type { AssistantMessage } from '../domain/conversation';
import type { DocumentCommand, DocumentOperation } from '../domain/document-command';
import type { RequestProgress } from '../application/handle-assistant-request';

const KIND_TITLE: Record<Exclude<AssistantMessage['kind'], 'proposal'>, string> = {
  greeting: 'Hi, I am here',
  summary: 'Document summary',
  explanation: 'Explanation',
  clarification: 'Hans needs a little more detail',
};

const PROPOSAL_TITLE: Record<DocumentOperation, string> = {
  insert_before: 'Proposed insertion',
  insert_after: 'Proposed insertion',
  replace: 'Proposed replacement',
  delete: 'Proposed deletion',
};

const NEED_STATUS: Record<Evidence, string> = {
  line_context: 'Hans is reading the nearby lines',
  selection: 'Hans is reading the selected text',
  logs: 'Hans is reading the logs',
};

const DOCUMENT_STATUS = 'Hans is reading the TeX content';

const STATUS_LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

export const REJECTED = 'Change rejected.';
export const INTERNAL_ERROR = 'Unexpected internal error. Details are in the browser console.';

export function messageTitle(message: AssistantMessage): string {
  if (message.kind !== 'proposal') return KIND_TITLE[message.kind];
  return PROPOSAL_TITLE[message.proposal.operation];
}

export function messageMeta(message: AssistantMessage): string {
  if (message.kind !== 'proposal') return '';
  const { proposal } = message;
  const first = String(proposal.lineNumber);
  switch (proposal.operation) {
    case 'insert_before':
    case 'insert_after':
      return `Anchor: line ${first}: ${proposal.lineText}`;
    case 'replace':
    case 'delete':
      if (proposal.lineCount === 1) return `Line ${first}: ${proposal.lineText}`;
      return `Lines ${first}–${String(proposal.lineNumber + proposal.lineCount - 1)}, starting: ${proposal.lineText}`;
  }
}

export function appliedNotice(command: DocumentCommand): string {
  switch (command.operation) {
    case 'insert_before':
      return 'Done. Inserted before the selected anchor.';
    case 'insert_after':
      return 'Done. Inserted after the selected anchor.';
    case 'replace':
      return command.lineCount === 1
        ? 'Done. Line replaced.'
        : `Done. ${String(command.lineCount)} lines replaced.`;
    case 'delete':
      return command.lineCount === 1
        ? 'Done. Line deleted.'
        : `Done. ${String(command.lineCount)} lines deleted.`;
  }
}

export function progressStatus(progress: RequestProgress): string {
  switch (progress.stage) {
    case 'received':
    case 'planning':
      return 'Hans is reading what it needs first...';
    case 'answering': {
      const parts = progress.plan.needs.map((need) => NEED_STATUS[need]);
      return STATUS_LIST.format([DOCUMENT_STATUS, ...parts]);
    }
  }
}
