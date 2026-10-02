import { isSameToolCall, type ToolCall } from './agent-action';
import { getToolTurns, type AgentTurn } from './agent-transcript';
import { RepeatedToolCallError, ToolBudgetExhaustedError } from './errors';

export const AGENT_POLICY = {
  maxToolCalls: 6,
  maxSearchMatches: 20,
  maxConsecutiveMistakes: 3,
  maxEditsPerChange: 8,
} as const;

export function countToolCallsLeft(transcript: readonly AgentTurn[]): number {
  return Math.max(0, AGENT_POLICY.maxToolCalls - getToolTurns(transcript).length);
}

export function checkToolCall(transcript: readonly AgentTurn[], call: ToolCall): void {
  if (countToolCallsLeft(transcript) === 0) {
    throw new ToolBudgetExhaustedError(
      `all ${String(AGENT_POLICY.maxToolCalls)} lookups are used; reply to the user now`,
    );
  }
  if (getToolTurns(transcript).some((turn) => isSameToolCall(turn.call, call))) {
    throw new RepeatedToolCallError(
      `${call.tool} was already called with the same argument; use its earlier result`,
    );
  }
}

export function hasMistakesLeft(transcript: readonly AgentTurn[]): boolean {
  const lastToolTurn = transcript.findLastIndex((turn) => turn.kind === 'tool');
  const trailingMistakes = transcript.length - 1 - lastToolTurn;
  return trailingMistakes < AGENT_POLICY.maxConsecutiveMistakes;
}
