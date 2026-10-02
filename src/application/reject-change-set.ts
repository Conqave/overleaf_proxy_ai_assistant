import { EditStatus } from '../domain/change-set';
import type { AgentProgress } from './agent-progress';
import { concludeDecision, type ChangeSetDeps, type ChangeSetOutcome } from './change-set-outcome';
import { recordingFailure } from './notices';
import type { OperationLock } from './operation-lock';

export class RejectChangeSet {
  constructor(private readonly deps: ChangeSetDeps & { readonly lock: OperationLock }) {}

  execute(
    proposalId: string,
    indexes: readonly number[] | null,
    onProgress: (progress: AgentProgress) => void,
  ): Promise<ChangeSetOutcome> {
    const { pendingChanges, conversation, lock } = this.deps;
    return lock.run((signal) =>
      recordingFailure(conversation, async () => {
        const rejected = pendingChanges.select(proposalId, indexes).map(({ index }) => index);
        const message = pendingChanges.decide(proposalId, rejected, EditStatus.Rejected);
        onProgress({ stage: 'decided', message });
        return await concludeDecision(this.deps, message, onProgress, signal);
      }),
    );
  }
}
