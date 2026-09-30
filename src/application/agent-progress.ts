import type { UserMessage } from '../domain/conversation';

export type AgentProgress =
  | { readonly stage: 'received'; readonly message: UserMessage }
  | { readonly stage: 'thinking'; readonly step: number }
  | { readonly stage: 'reading'; readonly path: string }
  | { readonly stage: 'searching'; readonly query: string }
  | { readonly stage: 'compiling' }
  | { readonly stage: 'opening'; readonly path: string };
