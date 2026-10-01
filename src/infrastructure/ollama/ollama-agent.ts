import type { AgentPort, AgentStep, AgentStepRequest } from '../../ports/agent-port';
import { AGENT_PROMPT_BUDGET, createAgentExchange } from './agent-protocol';
import { runExchange } from './correction-exchange';
import type { OllamaClient } from './ollama-client';

export class OllamaAgent implements AgentPort {
  constructor(private readonly client: OllamaClient) {}

  async decide(request: AgentStepRequest): Promise<AgentStep> {
    const exchange = createAgentExchange(request, AGENT_PROMPT_BUDGET);
    return await this.client.withDeadline([request.signal], async (deadline) => {
      const { value, contextUsage } = await runExchange(this.client, exchange, deadline);
      return { decision: value, contextUsage };
    });
  }
}
