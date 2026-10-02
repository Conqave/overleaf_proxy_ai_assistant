import type { EditRequest } from '../domain/change-set';
import type {
  CompactionSummaryMessage,
  ProposalMessage,
  SystemRequestMessage,
  ToolMessage,
  UserMessage,
} from '../domain/conversation';
import type { ContextUsage } from '../ports/agent-port';
import type { PendingWebSearch } from './web-search-approval';

export interface FileConflict {
  readonly path: string;
  readonly problem: string;
}

export interface ApplyReport {
  readonly applied: readonly EditRequest[];
  readonly conflicts: readonly FileConflict[];
}

export type AgentProgress =
  | { readonly stage: 'received'; readonly message: UserMessage | SystemRequestMessage }
  | { readonly stage: 'thinking'; readonly step: number }
  | { readonly stage: 'measured'; readonly contextUsage: ContextUsage }
  | { readonly stage: 'reading'; readonly path: string }
  | { readonly stage: 'searching'; readonly query: string }
  | { readonly stage: 'compiling' }
  | { readonly stage: 'awaiting-approval'; readonly search: PendingWebSearch }
  | { readonly stage: 'approval-decided'; readonly id: string; readonly approved: boolean }
  | { readonly stage: 'searching-web'; readonly query: string }
  | { readonly stage: 'delegating'; readonly task: string; readonly fileCount: number }
  | {
      readonly stage: 'subagent';
      readonly fileCount: number;
      readonly progress: AgentProgress;
    }
  | { readonly stage: 'recorded'; readonly message: ToolMessage }
  | { readonly stage: 'opening'; readonly path: string }
  | { readonly stage: 'decided'; readonly message: ProposalMessage }
  | { readonly stage: 'applied'; readonly report: ApplyReport }
  | { readonly stage: 'compacting' }
  | { readonly stage: 'compacted'; readonly message: CompactionSummaryMessage };
