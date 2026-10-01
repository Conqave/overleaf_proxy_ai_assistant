import type { CompactionSummaryMessage } from '../domain/conversation';
import {
  createCompactionSummaryMessage,
  createConversationSummary,
  summarizeView,
  type ConversationView,
} from '../domain/conversation-view';
import type { AgentPort, CompactionTrigger } from '../ports/agent-port';
import type { CancellationSignal } from '../ports/cancellation';
import type { ConversationSummarizer } from '../ports/conversation-summarizer';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';

export class ConversationCompactor {
  constructor(
    private readonly deps: {
      agent: AgentPort;
      summarizer: ConversationSummarizer;
      conversation: ConversationLog;
      newId: () => string;
      now: () => Date;
    },
  ) {}

  canCompact(conversation: ConversationView): boolean {
    return this.deps.agent.planCompaction({ kind: 'manual', conversation }) !== null;
  }

  async compact(
    trigger: CompactionTrigger,
    onProgress: (progress: AgentProgress) => void,
    signal: CancellationSignal,
  ): Promise<CompactionSummaryMessage | null> {
    const { agent, summarizer, conversation } = this.deps;
    const plan = agent.planCompaction(trigger);
    if (plan === null) return null;
    const epoch = conversation.epoch;
    const view = getView(trigger);
    onProgress({ stage: 'compacting' });
    const text = await summarizer.summarize({
      previous: view.summary,
      covered: plan.covered,
      signal,
    });
    conversation.ensureCurrent(epoch);
    const summary = createConversationSummary(view.summary, text, plan.covered);
    const message = createCompactionSummaryMessage({
      ...summary,
      id: this.deps.newId(),
      tokensBefore: agent.measureConversation(view),
      tokensAfter: agent.measureConversation(summarizeView(view, summary)),
      createdAt: this.deps.now().toISOString(),
    });
    conversation.append(message);
    onProgress({ stage: 'compacted', message });
    return message;
  }
}

function getView(trigger: CompactionTrigger): ConversationView {
  switch (trigger.kind) {
    case 'auto':
    case 'overflow':
      return trigger.step.conversation;
    case 'manual':
      return trigger.conversation;
  }
}
