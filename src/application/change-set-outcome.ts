import { hasAppliedEdits } from '../domain/change-set';
import { ProjectFileKind } from '../domain/project-file';
import type { ProposalMessage } from '../domain/conversation';
import type { CancellationSignal } from '../ports/cancellation';
import type { EditorPort } from '../ports/editor-port';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import type { PendingChanges } from './pending-change';
import type { ReviewAppliedChange, ReviewOutcome } from './review-applied-change';

export interface ChangeSetOutcome {
  readonly message: ProposalMessage;
  readonly review: ReviewOutcome | null;
}

export interface ChangeSetDeps {
  readonly project: ProjectPort;
  readonly conversation: ConversationLog;
  readonly editor: EditorPort;
  readonly pendingChanges: PendingChanges;
  readonly review: ReviewAppliedChange;
}

export async function concludeDecision(
  deps: ChangeSetDeps,
  message: ProposalMessage,
  onProgress: (progress: AgentProgress) => void,
  signal: CancellationSignal,
): Promise<ChangeSetOutcome> {
  if (deps.pendingChanges.isPending(message.id)) {
    previewPendingInShownFile(deps, message.id);
    return { message, review: null };
  }
  deps.editor.clearPreview();
  if (!hasAppliedEdits(message.edits)) return { message, review: null };
  return { message, review: await deps.review.execute(onProgress, signal) };
}

function previewPendingInShownFile(
  { project, editor, pendingChanges }: ChangeSetDeps,
  proposalId: string,
): void {
  const shown = project.shownFile();
  if (shown.kind !== ProjectFileKind.Text) return;
  const pending = pendingChanges.selectFile(proposalId, shown.path);
  if (pending.length === 0) {
    editor.clearPreview();
    return;
  }
  editor.showPreview(
    shown,
    pending.map(({ change }) => change.edit),
  );
}
