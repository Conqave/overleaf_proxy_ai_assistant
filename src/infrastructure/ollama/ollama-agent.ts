import type { ConversationView } from '../../domain/conversation-view';
import type {
  AgentPort,
  AgentStep,
  AgentStepRequest,
  CompactionPlan,
  CompactionTrigger,
} from '../../ports/agent-port';
import { createAgentExchange, measureConversationChars } from './agent-protocol';
import { planCompaction } from './compaction-planner';
import { describeUsage, fitIntoContext, TokenEstimate } from './context-budget';
import { runExchange } from './correction-exchange';
import type { OllamaClient } from './ollama-client';

export class OllamaAgent implements AgentPort {
  readonly idleUsage = describeUsage(0);
  private readonly estimate = new TokenEstimate();

  constructor(private readonly client: OllamaClient) {}

  async decide(request: AgentStepRequest): Promise<AgentStep> {
    return await this.client.withDeadline([request.signal], (deadline) =>
      fitIntoContext(async (promptChars) => {
        const exchange = createAgentExchange(request, promptChars);
        const outcome = await runExchange(this.client, exchange, deadline);
        this.estimate.calibrate(outcome.promptChars, outcome.contextUsage.promptTokens);
        return { decision: outcome.value, contextUsage: outcome.contextUsage };
      }),
    );
  }

  planCompaction(trigger: CompactionTrigger): CompactionPlan | null {
    return planCompaction(trigger, this.estimate);
  }

  measureConversation(conversation: ConversationView): number {
    return this.estimate.tokensOf(measureConversationChars(conversation));
  }
}
