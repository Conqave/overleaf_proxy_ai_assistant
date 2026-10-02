import { InvariantViolation } from '../domain/errors';
import type { CancellationSignal } from '../ports/cancellation';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import { AutoApprovalUnavailableError, WebSearchNoLongerPendingError } from './errors';

export const AutoApprovalScope = {
  Request: 'request',
  Session: 'session',
} as const;
export type AutoApprovalScope = (typeof AutoApprovalScope)[keyof typeof AutoApprovalScope];

export interface PendingWebSearch {
  readonly id: string;
  readonly query: string;
  readonly autoApprovalScopes: readonly AutoApprovalScope[];
}

export const WebSearchDecision = {
  Approve: 'approve',
  ApproveForRequest: 'approve-for-request',
  ApproveForSession: 'approve-for-session',
  Deny: 'deny',
} as const;
export type WebSearchDecision = (typeof WebSearchDecision)[keyof typeof WebSearchDecision];

export interface WebSearchContext {
  readonly query: string;
  readonly requestId: string;
}

interface WaitingSearch {
  readonly search: PendingWebSearch;
  readonly requestId: string;
  readonly settle: (approved: boolean) => void;
}

export class WebSearchApproval {
  private waiting: WaitingSearch | null = null;
  private approvedRequestId: string | null = null;
  private approvedSessionId: string | null = null;

  constructor(
    private readonly deps: {
      conversation: Pick<
        ConversationLog,
        'sessionId' | 'holdsUntrustedContent' | 'holdsUntrustedContentSince'
      >;
      newId: () => string;
    },
  ) {}

  async request(
    { query, requestId }: WebSearchContext,
    onProgress: (progress: AgentProgress) => void,
    signal: CancellationSignal,
  ): Promise<boolean> {
    if (signal.aborted) throw signal.reason;
    const scopes = this.findAutoApprovalScopes(requestId);
    if (this.isAutoApproved(requestId)) return true;
    if (this.waiting !== null) {
      throw new InvariantViolation('another web search is already waiting for approval');
    }
    const search: PendingWebSearch = { id: this.deps.newId(), query, autoApprovalScopes: scopes };
    const cancelled = Symbol('cancelled');
    const answer = new Promise<boolean | typeof cancelled>((resolve) => {
      const cancel = (): void => {
        this.waiting = null;
        resolve(cancelled);
      };
      signal.addEventListener('abort', cancel);
      this.waiting = {
        search,
        requestId,
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
      case WebSearchDecision.ApproveForRequest:
        requireScope(waiting.search, AutoApprovalScope.Request);
        this.approvedRequestId = waiting.requestId;
        waiting.settle(true);
        break;
      case WebSearchDecision.ApproveForSession:
        requireScope(waiting.search, AutoApprovalScope.Session);
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

  private findAutoApprovalScopes(requestId: string): readonly AutoApprovalScope[] {
    const { conversation } = this.deps;
    const scopes: AutoApprovalScope[] = [];
    if (conversation.holdsUntrustedContentSince(requestId)) this.approvedRequestId = null;
    else scopes.push(AutoApprovalScope.Request);
    if (conversation.holdsUntrustedContent()) this.approvedSessionId = null;
    else scopes.push(AutoApprovalScope.Session);
    return scopes;
  }

  private isAutoApproved(requestId: string): boolean {
    const { sessionId } = this.deps.conversation;
    const isSessionApproved = sessionId !== null && sessionId === this.approvedSessionId;
    return isSessionApproved || requestId === this.approvedRequestId;
  }

  private requireSessionId(): string {
    const { sessionId } = this.deps.conversation;
    if (sessionId === null) {
      throw new InvariantViolation('a web search waits for approval outside of a session');
    }
    return sessionId;
  }
}

function requireScope(search: PendingWebSearch, scope: AutoApprovalScope): void {
  if (!search.autoApprovalScopes.includes(scope)) throw new AutoApprovalUnavailableError(scope);
}
