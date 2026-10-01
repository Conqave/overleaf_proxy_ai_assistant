import type { CompactionSummaryMessage } from '../domain/conversation';
import { viewConversation } from '../domain/conversation-view';
import type { AgentProgress } from './agent-progress';
import type { ConversationCompactor } from './conversation-compactor';
import type { ConversationLog } from './conversation-log';
import { NothingToCompactError } from './errors';
import type { OperationLock } from './operation-lock';

export class CompactConversation {
  constructor(
    private readonly deps: {
      compactor: ConversationCompactor;
      conversation: ConversationLog;
      lock: OperationLock;
    },
  ) {}

  canCompact(): boolean {
    return this.deps.compactor.canCompact(viewConversation(this.deps.conversation.messages()));
  }

  execute(onProgress: (progress: AgentProgress) => void): Promise<CompactionSummaryMessage> {
    return this.deps.lock.run(async (signal) => {
      const conversation = viewConversation(this.deps.conversation.messages());
      const summary = await this.deps.compactor.compact(
        { kind: 'manual', conversation },
        onProgress,
        signal,
      );
      if (summary === null) throw new NothingToCompactError();
      return summary;
    });
  }
}
