import { EditStatus, type ProposedEdit } from '../../src/domain/change-set';
import type { ProposalMessage } from '../../src/domain/conversation';
import type { DocumentCommand } from '../../src/domain/document-command';

export function editWith(path: string, command: DocumentCommand, status: EditStatus): ProposedEdit {
  if (status !== EditStatus.Applied) return { path, command, status };
  return {
    path,
    command,
    status,
    applied: { line: command.target.lineNumber, before: ['old'], after: ['new'], sequence: 0 },
  };
}

export function proposalOf(id: string, ...edits: readonly ProposedEdit[]): ProposalMessage {
  return { id, role: 'assistant', kind: 'proposal', edits };
}
