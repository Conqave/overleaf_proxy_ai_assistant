import type { ConversationLog } from './conversation-log';
import { OperationStoppedError } from './errors';
import type { OperationLock } from './operation-lock';

export class StopOperation {
  constructor(
    private readonly deps: {
      conversation: ConversationLog;
      lock: OperationLock;
    },
  ) {}

  async execute(): Promise<void> {
    const { conversation, lock } = this.deps;
    if (!(await lock.cancel(new OperationStoppedError()))) return;
    await lock.run(() => {
      if (conversation.sessionId !== null) conversation.recordNotice({ kind: 'cancelled' });
      return Promise.resolve();
    });
  }
}
