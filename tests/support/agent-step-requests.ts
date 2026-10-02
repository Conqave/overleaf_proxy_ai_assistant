import type { AgentStepRequest, AgentWorkspace } from '../../src/ports/agent-port';
import { EMPTY_CONVERSATION } from './fakes';
import { MAIN_AGENT_POLICY } from './policies';

export function userStepRequest(
  text: string,
  workspace: AgentWorkspace,
  overrides: Partial<AgentStepRequest> = {},
): AgentStepRequest {
  return {
    request: { kind: 'user', message: { id: 'r', role: 'user', text } },
    policy: MAIN_AGENT_POLICY,
    conversation: EMPTY_CONVERSATION,
    signal: new AbortController().signal,
    workspace,
    transcript: [],
    ...overrides,
  };
}
