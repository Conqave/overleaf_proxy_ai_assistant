import { isSameToolCall, type ToolCall } from './agent-action';
import type { AgentTurn } from './agent-transcript';
import { RepeatedToolCallError, ToolBudgetExhaustedError } from './errors';

export const AGENT_POLICY = {
  maxToolCalls: 6,
  maxSearchMatches: 20,
} as const;

export function canCallTools(transcript: readonly AgentTurn[]): boolean {
  return transcript.length < AGENT_POLICY.maxToolCalls;
}

export function checkToolCall(transcript: readonly AgentTurn[], call: ToolCall): void {
  if (!canCallTools(transcript)) {
    throw new ToolBudgetExhaustedError(
      `all ${String(AGENT_POLICY.maxToolCalls)} tool calls are used; reply to the user now`,
    );
  }
  if (transcript.some((turn) => isSameToolCall(turn.call, call))) {
    throw new RepeatedToolCallError(
      `${call.tool} was already called with the same argument; use its earlier result`,
    );
  }
}
