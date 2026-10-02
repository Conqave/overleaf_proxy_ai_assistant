import { InvariantViolation } from '../domain/errors';
import type { CancellationSignal } from '../ports/cancellation';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import { WebSearchNoLongerPendingError } from './errors';

export interface PendingWebSearch {
  readonly id: string;
  readonly query: string;
}

export const WebSearchDecision = {
  Approve: 'approve',
  ApproveForSession: 'approve-for-session',
  Deny: 'deny',
} as const;
export type WebSearchDecision = (typeof WebSearchDecision)[keyof typeof WebSearchDecision];

interface WaitingSearch {
  readonly search: PendingWebSearch;
  readonly settle: (approved: boolean) => void;
}

export class WebSearchApproval {
  private waiting: WaitingSearch | null = null;
  private approvedSessionId: string | null = null;

  constructor(
    private readonly deps: {
      conversation: Pick<ConversationLog, 'sessionId'>;
      newId: () => string;
    },
  ) {}

  async request(
    query: string,
    onProgress: (progress: AgentProgress) => void,
    signal: CancellationSignal,
  ): Promise<boolean> {
    if (signal.aborted) throw signal.reason;
    if (this.isApprovedForSession()) return true;
    if (this.waiting !== null) {
      throw new InvariantViolation('another web search is already waiting for approval');
    }
    const search: PendingWebSearch = { id: this.deps.newId(), query };
    const cancelled = Symbol('cancelled');
    const answer = new Promise<boolean | typeof cancelled>((resolve) => {
      const cancel = (): void => {
        this.waiting = null;
        resolve(cancelled);
      };
      signal.addEventListener('abort', cancel);
      this.waiting = {
        search,
        settle: (approved) => {
          signal.removeEventListener('abort', cancel);
          this.waiting = null;
          resolve(approved);
        },
      };
    });
    onProgress({ stage: 'awaiting-approval', search });
    const approved = await answer;
    if (approved === cancelled) throw signal.reason;
    onProgress({ stage: 'approval-decided', id: search.id, approved });
    return approved;
  }

  decide(id: string, decision: WebSearchDecision): void {
    const { waiting } = this;
    if (waiting?.search.id !== id) throw new WebSearchNoLongerPendingError();
    switch (decision) {
      case WebSearchDecision.ApproveForSession:
        this.approvedSessionId = this.requireSessionId();
        waiting.settle(true);
        break;
      case WebSearchDecision.Approve:
        waiting.settle(true);
        break;
      case WebSearchDecision.Deny:
        waiting.settle(false);
    }
  }

  private isApprovedForSession(): boolean {
    const { sessionId } = this.deps.conversation;
    return sessionId !== null && sessionId === this.approvedSessionId;
  }

  private requireSessionId(): string {
    const { sessionId } = this.deps.conversation;
    if (sessionId === null) {
      throw new InvariantViolation('a web search waits for approval outside of a session');
    }
    return sessionId;
  }
}
