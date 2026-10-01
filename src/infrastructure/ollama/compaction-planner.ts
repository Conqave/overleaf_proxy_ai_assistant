import { isRequestMessage, type ExchangeMessage } from '../../domain/conversation';
import type { ConversationView } from '../../domain/conversation-view';
import { InvariantViolation } from '../../domain/errors';
import type { CompactionPlan, CompactionTrigger } from '../../ports/agent-port';
import { measureAgentPromptChars, measureConversationChars } from './agent-protocol';
import {
  AUTO_COMPACTION_TOKENS,
  MANUAL_COMPACTION_KEEP_RATIO,
  MIN_COMPACTED_TOKENS,
  PRESERVED_RECENT_TOKENS,
  type TokenEstimate,
} from './context-budget';
import { entryText, getViewRecords } from './conversation-text';
import { findOutdatedReads } from './outdated-reads';

interface Cut {
  readonly conversation: ConversationView;
  readonly keptTokens: number;
  readonly keptFrom: number;
}

export function planCompaction(
  trigger: CompactionTrigger,
  estimate: TokenEstimate,
): CompactionPlan | null {
  const cut = getCut(trigger, estimate);
  if (cut === null) return null;
  const { messages } = cut.conversation;
  const sizes = getMessageTokens(cut.conversation, estimate);
  let start = messages.length;
  let kept = 0;
  while (start > 0 && kept + itemAt(sizes, start - 1) <= cut.keptTokens) {
    start -= 1;
    kept += itemAt(sizes, start);
  }
  start = Math.min(start, cut.keptFrom);
  while (start > 0 && !isTurnStart(messages, start)) start -= 1;
  const coveredTokens = sizes.slice(0, start).reduce((total, size) => total + size, 0);
  if (coveredTokens < MIN_COMPACTED_TOKENS) return null;
  return { covered: messages.slice(0, start) };
}

function getCut(trigger: CompactionTrigger, estimate: TokenEstimate): Cut | null {
  switch (trigger.kind) {
    case 'auto': {
      const promptTokens = estimate.tokensOf(measureAgentPromptChars(trigger.step));
      if (promptTokens < AUTO_COMPACTION_TOKENS) return null;
      const { conversation } = trigger.step;
      return {
        conversation,
        keptTokens: PRESERVED_RECENT_TOKENS,
        keptFrom: conversation.messages.length,
      };
    }
    case 'manual': {
      const { conversation } = trigger;
      const lastRequest = conversation.messages.findLastIndex(isRequestMessage);
      if (lastRequest === -1) return null;
      const conversationTokens = estimate.tokensOf(measureConversationChars(conversation));
      return {
        conversation,
        keptTokens: Math.floor(conversationTokens * MANUAL_COMPACTION_KEEP_RATIO),
        keptFrom: lastRequest,
      };
    }
  }
}

function getMessageTokens(conversation: ConversationView, estimate: TokenEstimate): number[] {
  const outdated = findOutdatedReads(getViewRecords(conversation));
  return conversation.messages.map((message) =>
    estimate.tokensOf(entryText(message, outdated).length),
  );
}

function isTurnStart(messages: readonly ExchangeMessage[], index: number): boolean {
  const message = messages[index];
  return message !== undefined && isRequestMessage(message);
}

function itemAt(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new InvariantViolation(`no size for message ${String(index)}`);
  return value;
}
