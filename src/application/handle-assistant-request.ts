import type { ContextUsage } from '../domain/context-usage';
import type { AgentPort } from '../ports/agent-port';
import type { AgentProgress } from './agent-progress';
import type { AgentResult, ConversationAgent } from './conversation-agent';
import { EmptyRequestError } from './errors';
import type { OperationLock } from './operation-lock';

export class HandleAssistantRequest {
  constructor(
    private readonly deps: {
      agent: Pick<AgentPort, 'idleUsage'>;
      conversationAgent: ConversationAgent;
      lock: OperationLock;
    },
  ) {}

  getUnusedContext(): ContextUsage {
    return this.deps.agent.idleUsage;
  }

  async execute(text: string, onProgress: (progress: AgentProgress) => void): Promise<AgentResult> {
    const request = text.trim();
    if (!request) throw new EmptyRequestError();
    return await this.deps.lock.run((signal) =>
      this.deps.conversationAgent.respond(request, onProgress, signal),
    );
  }
}
