import type { AgentDecision, ToolCall } from '../../src/domain/agent-action';

export function answer(text: string): AgentDecision {
  return { kind: 'reply', reply: { kind: 'answer', text } };
}

export function tool(call: ToolCall): AgentDecision {
  return { kind: 'tool', call };
}
