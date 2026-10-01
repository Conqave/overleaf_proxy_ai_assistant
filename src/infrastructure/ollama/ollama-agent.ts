import type { AgentDecision } from '../../domain/agent-action';
import type { AgentPort, AgentStepRequest } from '../../ports/agent-port';
import { createAgentExchange } from './agent-protocol';
import { getPromptBudget } from './assistant-protocol';
import { runExchange } from './correction-exchange';
import type { OllamaClient } from './ollama-client';

export class OllamaAgent implements AgentPort {
  private readonly promptBudget: number;

  constructor(private readonly client: OllamaClient) {
    this.promptBudget = getPromptBudget(client.contextTokens);
  }

  async decide(request: AgentStepRequest): Promise<AgentDecision> {
    return await runExchange(this.client, createAgentExchange(request, this.promptBudget));
  }
}
