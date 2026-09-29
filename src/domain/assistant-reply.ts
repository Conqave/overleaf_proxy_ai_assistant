import type { ResolvedEdit } from './resolved-edit';

export type AssistantReply =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'question'; readonly text: string }
  | { readonly kind: 'edit'; readonly edit: ResolvedEdit; readonly rationale?: string };
