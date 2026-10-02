import type { ContextUsage } from '../domain/context-usage';
import type { AgentPort } from '../ports/agent-port';
import type { ConversationLog } from './conversation-log';

export class ReadContextUsage {
  constructor(
    private readonly deps: {
      conversation: Pick<ConversationLog, 'contextUsage'>;
      agent: Pick<AgentPort, 'idleUsage'>;
    },
  ) {}

  execute(): ContextUsage {
    const { contextUsage } = this.deps.conversation;
    return contextUsage === null ? this.deps.agent.idleUsage : contextUsage;
  }
}
