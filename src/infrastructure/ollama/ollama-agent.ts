import type { AgentPort, AgentStep, AgentStepRequest } from '../../ports/agent-port';
import { createAgentExchange } from './agent-protocol';
import { fitIntoContext } from './context-budget';
import { runExchange } from './correction-exchange';
import type { OllamaClient } from './ollama-client';

export class OllamaAgent implements AgentPort {
  constructor(private readonly client: OllamaClient) {}

  async decide(request: AgentStepRequest): Promise<AgentStep> {
    return await this.client.withDeadline([request.signal], (deadline) =>
      fitIntoContext(async (promptChars) => {
        const exchange = createAgentExchange(request, promptChars);
        const { value, contextUsage } = await runExchange(this.client, exchange, deadline);
        return { decision: value, contextUsage };
      }),
    );
  }
}
