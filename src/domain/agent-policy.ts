import { AgentTool, isSameToolCall, type AgentReply, type ToolCall } from './agent-action';
import {
  findUncheckedFiles,
  getToolTurns,
  type AgentTurn,
  type ToolTurn,
} from './agent-transcript';
import {
  DelegationLimitError,
  ReplyNotAllowedError,
  RepeatedToolCallError,
  ToolBudgetExhaustedError,
  ToolNotAllowedError,
  UncheckedFilesError,
} from './errors';

export const AGENT_POLICY = {
  maxSearchMatches: 20,
  maxConsecutiveMistakes: 3,
  maxEditsPerChange: 8,
  maxDelegations: 2,
  maxDelegationResultChars: 1_500,
} as const;

export const AgentRole = {
  Main: 'main',
  Subagent: 'subagent',
} as const;
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

export type AgentReplyKind = AgentReply['kind'];

export interface AgentPolicy {
  readonly role: AgentRole;
  readonly tools: readonly AgentTool[];
  readonly replies: readonly AgentReplyKind[];
  readonly maxToolCalls: number;
}

export const MAIN_AGENT_POLICY: AgentPolicy = Object.freeze({
  role: AgentRole.Main,
  tools: Object.freeze([
    AgentTool.ReadFile,
    AgentTool.Search,
    AgentTool.Compile,
    AgentTool.Delegate,
  ]),
  replies: Object.freeze(['answer', 'question', 'edit'] as const),
  maxToolCalls: 6,
});

export const SUBAGENT_POLICY: AgentPolicy = Object.freeze({
  role: AgentRole.Subagent,
  tools: Object.freeze([AgentTool.ReadFile, AgentTool.Search]),
  replies: Object.freeze(['answer'] as const),
  maxToolCalls: 10,
});

export function countToolCallsLeft(policy: AgentPolicy, transcript: readonly AgentTurn[]): number {
  return Math.max(0, policy.maxToolCalls - getToolTurns(transcript).length);
}

export function checkToolCall(
  policy: AgentPolicy,
  transcript: readonly AgentTurn[],
  call: ToolCall,
): void {
  if (!policy.tools.includes(call.tool)) {
    throw new ToolNotAllowedError(
      `${call.tool} is not available in this task; use only ${policy.tools.join(' or ')}`,
    );
  }
  if (countToolCallsLeft(policy, transcript) === 0) {
    throw new ToolBudgetExhaustedError(
      `all ${String(policy.maxToolCalls)} lookups are used; reply now with ${policy.replies.join(', ')}`,
    );
  }
  const turns = getToolTurns(transcript);
  const earlier = turns.find((turn) => isSameToolCall(turn.call, call));
  if (earlier !== undefined) throw new RepeatedToolCallError(repeatedCallProblem(policy, earlier));
  const delegations = turns.filter((turn) => turn.call.tool === AgentTool.Delegate).length;
  if (call.tool === AgentTool.Delegate && delegations >= AGENT_POLICY.maxDelegations) {
    throw new DelegationLimitError(
      `all ${String(AGENT_POLICY.maxDelegations)} delegations of this request are used; do the remaining lookups yourself or reply`,
    );
  }
}

function repeatedCallProblem(policy: AgentPolicy, { call, result }: ToolTurn): string {
  const repeated = `${call.tool} was already called with the same argument`;
  if (result.tool !== AgentTool.Search || !result.truncated) {
    return `${repeated}; use its earlier result`;
  }
  const delegation = policy.tools.includes(AgentTool.Delegate)
    ? `, or ${AgentTool.Delegate} the whole check`
    : '';
  return `${repeated} and its result was cut, so repeating it shows nothing new; search for something narrower or only in one file or folder${delegation}`;
}

export function checkReply(policy: AgentPolicy, reply: AgentReply): void {
  if (!policy.replies.includes(reply.kind)) {
    throw new ReplyNotAllowedError(
      `${reply.kind} is not available in this task; reply with ${policy.replies.join(' or ')}`,
    );
  }
}

export function checkFilesChecked(
  policy: AgentPolicy,
  transcript: readonly AgentTurn[],
  paths: readonly string[],
): void {
  if (countToolCallsLeft(policy, transcript) === 0) return;
  const unchecked = findUncheckedFiles(paths, transcript);
  if (unchecked.length) {
    throw new UncheckedFilesError(
      `${unchecked.join(', ')} of the task ${unchecked.length === 1 ? 'is' : 'are'} not checked yet; ${AgentTool.ReadFile} or ${AgentTool.Search} each of them before you reply`,
    );
  }
}

export function hasMistakesLeft(transcript: readonly AgentTurn[]): boolean {
  const lastToolTurn = transcript.findLastIndex((turn) => turn.kind === 'tool');
  const trailingMistakes = transcript.length - 1 - lastToolTurn;
  return trailingMistakes < AGENT_POLICY.maxConsecutiveMistakes;
}
