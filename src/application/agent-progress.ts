import type {
  CompactionSummaryMessage,
  ProposalMessage,
  SystemRequestMessage,
  UserMessage,
} from '../domain/conversation';

export type AgentProgress =
  | { readonly stage: 'received'; readonly message: UserMessage | SystemRequestMessage }
  | { readonly stage: 'thinking'; readonly step: number }
  | { readonly stage: 'reading'; readonly path: string }
  | { readonly stage: 'searching'; readonly query: string }
  | { readonly stage: 'compiling' }
  | { readonly stage: 'opening'; readonly path: string }
  | { readonly stage: 'decided'; readonly message: ProposalMessage }
  | { readonly stage: 'compacting' }
  | { readonly stage: 'compacted'; readonly message: CompactionSummaryMessage };
