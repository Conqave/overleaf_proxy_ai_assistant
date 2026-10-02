import type { AgentDecision } from '../domain/agent-action';
import { hasMistakesLeft } from '../domain/agent-policy';
import type { AgentTurn, ToolResult, ToolTurn } from '../domain/agent-transcript';
import type { ConversationView } from '../domain/conversation-view';
import type {
  AgentPort,
  AgentRequest,
  AgentStep,
  AgentStepRequest,
  AgentWorkspace,
  ContextUsage,
} from '../ports/agent-port';
import type { CancellationSignal } from '../ports/cancellation';
import { AssistantContextOverflowError } from '../ports/errors';
import {
  acceptDecision,
  isAgentMistake,
  type AcceptedDecision,
  type AcceptedReply,
  type AgentMistake,
} from './agent-decision';
import type { AgentProgress } from './agent-progress';
import type { ConversationCompactor } from './conversation-compactor';
import { AgentMistakeLimitError } from './errors';
import type { ProjectTools } from './project-tools';

export interface AgentRunHost {
  viewHistory(): ConversationView;
  ensureCurrent(): void;
  recordLookup(turn: ToolTurn): void;
}

export interface AgentRun {
  readonly request: AgentRequest;
  readonly workspace: AgentWorkspace;
  readonly host: AgentRunHost;
  readonly signal: CancellationSignal;
  readonly onProgress: (progress: AgentProgress) => void;
}

export interface AgentOutcome {
  readonly reply: AcceptedReply;
  readonly contextUsage: ContextUsage;
}

export class AgentLoop {
  constructor(
    private readonly deps: {
      agent: AgentPort;
      compactor: ConversationCompactor;
      tools: ProjectTools;
    },
  ) {}

  async run(run: AgentRun): Promise<AgentOutcome> {
    const { request, workspace, host, signal, onProgress } = run;
    const transcript: AgentTurn[] = [];
    const stepRequest = (): AgentStepRequest => ({
      request,
      conversation: host.viewHistory(),
      workspace,
      transcript: [...transcript],
      signal,
    });
    let isCompacted = false;
    for (let step = 1; ; step += 1) {
      if (!isCompacted) {
        const summary = await this.deps.compactor.compact(
          { kind: 'auto', step: stepRequest() },
          onProgress,
          signal,
        );
        isCompacted = summary !== null;
      }
      onProgress({ stage: 'thinking', step });
      const { decision, contextUsage } = await this.decide(stepRequest, step, run);
      host.ensureCurrent();
      let accepted: AcceptedDecision;
      try {
        accepted = acceptDecision(decision, workspace, transcript);
      } catch (error) {
        if (!isAgentMistake(error)) throw error;
        recordMistake(transcript, decision, error);
        continue;
      }
      if (accepted.kind !== 'tool') return { reply: accepted, contextUsage };
      let result: ToolResult;
      try {
        result = await this.deps.tools.run(accepted.run, onProgress, signal);
      } catch (error) {
        if (!isAgentMistake(error)) throw error;
        recordMistake(transcript, decision, error);
        continue;
      }
      host.ensureCurrent();
      const turn: ToolTurn = { kind: 'tool', call: accepted.call, result };
      transcript.push(turn);
      host.recordLookup(turn);
    }
  }

  private async decide(
    stepRequest: () => AgentStepRequest,
    step: number,
    { signal, onProgress }: AgentRun,
  ): Promise<AgentStep> {
    const { agent, compactor } = this.deps;
    try {
      return await agent.decide(stepRequest());
    } catch (error) {
      if (!(error instanceof AssistantContextOverflowError)) throw error;
    }
    await compactor.compact({ kind: 'overflow', step: stepRequest() }, onProgress, signal);
    onProgress({ stage: 'thinking', step });
    return await agent.decideShortened(stepRequest());
  }
}

function recordMistake(
  transcript: AgentTurn[],
  decision: AgentDecision,
  mistake: AgentMistake,
): void {
  transcript.push({ kind: 'mistake', decision, problem: mistake.message });
  if (!hasMistakesLeft(transcript)) throw new AgentMistakeLimitError(mistake);
}
