import type { AgentPort, AgentStep, AgentStepRequest } from '../../ports/agent-port';
import { createAgentExchange } from './agent-protocol';
import { getPromptBudget } from './prompt-blocks';
import { runExchange } from './correction-exchange';
import type { OllamaClient } from './ollama-client';

export class OllamaAgent implements AgentPort {
  private readonly promptBudget: number;

  constructor(private readonly client: OllamaClient) {
    this.promptBudget = getPromptBudget(client.contextTokens);
  }

  async decide(request: AgentStepRequest): Promise<AgentStep> {
    const exchange = createAgentExchange(request, this.promptBudget);
    const { value, contextUsage } = await runExchange(this.client, exchange);
    return { decision: value, contextUsage };
  }
}
