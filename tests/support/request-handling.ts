import { AgentLoop } from '../../src/application/agent-loop';
import { ConversationAgent } from '../../src/application/conversation-agent';
import type { ConversationCompactor } from '../../src/application/conversation-compactor';
import type { ConversationLog } from '../../src/application/conversation-log';
import { HandleAssistantRequest } from '../../src/application/handle-assistant-request';
import type { OperationLock } from '../../src/application/operation-lock';
import type { PendingChanges } from '../../src/application/pending-change';
import { ProjectTools } from '../../src/application/project-tools';
import type { WebSearchTool } from '../../src/application/web-search-tool';
import { createAgentPolicies } from '../../src/domain/agent-policy';
import type { AgentPort } from '../../src/ports/agent-port';
import type { EditorPort } from '../../src/ports/editor-port';
import type { ProjectPort } from '../../src/ports/project-port';

export interface RequestHandlingDeps {
  readonly agent: AgentPort;
  readonly project: ProjectPort;
  readonly editor: EditorPort;
  readonly conversation: ConversationLog;
  readonly pendingChanges: PendingChanges;
  readonly lock: OperationLock;
  readonly newId: () => string;
  readonly compactor: ConversationCompactor;
  readonly webSearch: WebSearchTool | null;
}

export interface RequestHandling {
  readonly conversationAgent: ConversationAgent;
  readonly handleRequest: HandleAssistantRequest;
}

export function composeRequestHandling(deps: RequestHandlingDeps): RequestHandling {
  const { agent, project, editor, conversation, pendingChanges, lock, newId, webSearch } = deps;
  const loop = new AgentLoop({
    agent,
    compactor: deps.compactor,
    tools: new ProjectTools(project, () => new AbortController()),
    webSearch,
    policies: createAgentPolicies({ webSearch: webSearch !== null }),
  });
  const conversationAgent = new ConversationAgent({
    loop,
    project,
    editor,
    conversation,
    pendingChanges,
    lock,
    newId,
  });
  return {
    conversationAgent,
    handleRequest: new HandleAssistantRequest({ conversationAgent, lock }),
  };
}
