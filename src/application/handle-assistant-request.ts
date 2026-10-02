import type { AgentProgress } from './agent-progress';
import type { AgentResult, ConversationAgent } from './conversation-agent';
import type { ConversationLog } from './conversation-log';
import { EmptyRequestError } from './errors';
import { recordingFailure } from './notices';
import type { OperationLock } from './operation-lock';

export class HandleAssistantRequest {
  constructor(
    private readonly deps: {
      conversationAgent: ConversationAgent;
      conversation: ConversationLog;
      lock: OperationLock;
    },
  ) {}

  async execute(text: string, onProgress: (progress: AgentProgress) => void): Promise<AgentResult> {
    const request = text.trim();
    if (!request) throw new EmptyRequestError();
    const { conversationAgent, conversation, lock } = this.deps;
    return await lock.run((signal) =>
      recordingFailure(conversation, () => conversationAgent.respond(request, onProgress, signal)),
    );
  }
}
