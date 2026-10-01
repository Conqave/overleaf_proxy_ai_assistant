import type { ConversationView } from '../../domain/conversation-view';
import type {
  AgentPort,
  AgentStep,
  AgentStepRequest,
  CompactionPlan,
  CompactionTrigger,
} from '../../ports/agent-port';
import { AssistantContextOverflowError } from '../../ports/errors';
import { createAgentExchange, measureConversationChars } from './agent-protocol';
import { planCompaction } from './compaction-planner';
import {
  ContextOverflowError,
  describeUsage,
  ESTIMATED_PROMPT_CHARS,
  fitIntoContext,
  TokenEstimate,
} from './context-budget';
import { runExchange } from './correction-exchange';
import type { OllamaClient } from './ollama-client';

export class OllamaAgent implements AgentPort {
  readonly idleUsage = describeUsage(0);
  private readonly estimate = new TokenEstimate();

  constructor(private readonly client: OllamaClient) {}

  async decide(request: AgentStepRequest): Promise<AgentStep> {
    return await this.client.withDeadline([request.signal], async (deadline) => {
      try {
        return await this.decideWithin(request, ESTIMATED_PROMPT_CHARS, deadline);
      } catch (error) {
        if (!(error instanceof ContextOverflowError)) throw error;
        throw new AssistantContextOverflowError(
          `The prompt took ${String(error.promptTokens)} tokens, more than the model's context window holds.`,
          { cause: error },
        );
      }
    });
  }

  async decideShortened(request: AgentStepRequest): Promise<AgentStep> {
    return await this.client.withDeadline([request.signal], (deadline) =>
      fitIntoContext((promptChars) => this.decideWithin(request, promptChars, deadline)),
    );
  }

  planCompaction(trigger: CompactionTrigger): CompactionPlan | null {
    return planCompaction(trigger, this.estimate);
  }

  measureConversation(conversation: ConversationView): number {
    return this.estimate.tokensOf(measureConversationChars(conversation));
  }

  private async decideWithin(
    request: AgentStepRequest,
    promptChars: number,
    deadline: AbortSignal,
  ): Promise<AgentStep> {
    const exchange = createAgentExchange(request, promptChars);
    const outcome = await runExchange(this.client, exchange, deadline);
    this.estimate.calibrate(outcome.promptChars, outcome.contextUsage.promptTokens);
    return { decision: outcome.value, contextUsage: outcome.contextUsage };
  }
}
