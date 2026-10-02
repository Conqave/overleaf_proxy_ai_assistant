import type {
  CompactionSummaryMessage,
  NoticeMessage,
  ProposalMessage,
  SystemRequestMessage,
  ToolMessage,
  UndoMessage,
  UserMessage,
} from '../domain/conversation';
import type { ContextUsage } from '../domain/context-usage';
import type { PendingWebSearch } from './web-search-approval';

export interface FileConflict {
  readonly path: string;
  readonly problem: string;
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
  | { readonly stage: 'recorded'; readonly message: ToolMessage | UndoMessage }
  | { readonly stage: 'opening'; readonly path: string }
  | { readonly stage: 'decided'; readonly message: ProposalMessage }
  | { readonly stage: 'noted'; readonly message: NoticeMessage }
  | { readonly stage: 'compacting' }
  | { readonly stage: 'compacted'; readonly message: CompactionSummaryMessage };
