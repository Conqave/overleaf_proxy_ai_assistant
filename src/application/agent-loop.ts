import { AgentTool, type AgentDecision } from '../domain/agent-action';
import {
  AGENT_POLICY,
  hasMistakesLeft,
  type AgentPolicies,
  type AgentPolicy,
} from '../domain/agent-policy';
import type { AgentTurn, ToolResult, ToolTurn } from '../domain/agent-transcript';
import type { ConversationView } from '../domain/conversation-view';
import { failDelegation, finishDelegation } from '../domain/delegation';
import { InvariantViolation } from '../domain/errors';
import { listTextFiles } from '../domain/project-file';
import type {
  AgentPort,
  AgentRequest,
  AgentStep,
  AgentStepRequest,
  AgentWorkspace,
  ContextUsage,
} from '../ports/agent-port';
import type { CancellationSignal } from '../ports/cancellation';
import { AssistantContextOverflowError, AssistantProtocolError } from '../ports/errors';
import {
  acceptDecision,
  isAgentMistake,
  type AcceptedDecision,
  type AcceptedDelegation,
  type AcceptedReply,
  type AcceptedWebSearch,
  type AgentMistake,
} from './agent-decision';
import type { AgentProgress } from './agent-progress';
import type { ConversationCompactor } from './conversation-compactor';
import { ensureNotCancelled } from './operation-lock';
import { AgentMistakeLimitError } from './errors';
import type { ProjectTools } from './project-tools';
import type { WebSearchTool } from './web-search-tool';

export interface AgentRunHost {
  viewHistory(): ConversationView;
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

const NO_HISTORY: ConversationView = Object.freeze({
  summary: null,
  messages: Object.freeze([]),
  imported: null,
});

export class AgentLoop {
  constructor(
    private readonly deps: {
      agent: AgentPort;
      compactor: ConversationCompactor;
      tools: ProjectTools;
      webSearch: WebSearchTool | null;
      policies: AgentPolicies;
    },
  ) {}

  async run(run: AgentRun): Promise<AgentOutcome> {
    const { request, workspace, host, signal, onProgress } = run;
    const policy = this.policyOf(request);
    const transcript: AgentTurn[] = [];
    const stepRequest = (): AgentStepRequest => ({
      request,
      policy,
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
      ensureNotCancelled(signal);
      onProgress({ stage: 'measured', contextUsage });
      let accepted: AcceptedDecision;
      try {
        accepted = acceptDecision(decision, { request, policy }, workspace, transcript);
      } catch (error) {
        if (!isAgentMistake(error)) throw error;
        recordMistake(transcript, decision, error);
        continue;
      }
      let result: ToolResult;
      switch (accepted.kind) {
        case 'answer':
        case 'question':
        case 'edit':
          return { reply: accepted, contextUsage };
        case 'delegate':
          result = await this.delegate(accepted, run);
          break;
        case 'web-search':
          result = await this.searchWeb(accepted, run);
          break;
        case 'tool':
          try {
            result = await this.deps.tools.run(accepted.run, onProgress, signal);
          } catch (error) {
            if (!isAgentMistake(error)) throw error;
            recordMistake(transcript, decision, error);
            continue;
          }
      }
      ensureNotCancelled(signal);
      const turn: ToolTurn = { kind: 'tool', call: accepted.call, result };
      transcript.push(turn);
      host.recordLookup(turn);
    }
  }

  private policyOf(request: AgentRequest): AgentPolicy {
    switch (request.kind) {
      case 'user':
      case 'compile-fix':
        return this.deps.policies.main;
      case 'subtask':
        return this.deps.policies.subagent;
    }
  }

  private async searchWeb(
    { call }: AcceptedWebSearch,
    { signal, onProgress }: AgentRun,
  ): Promise<ToolResult> {
    const { webSearch } = this.deps;
    if (webSearch === null) {
      throw new InvariantViolation('the policy allowed a web search without a search service');
    }
    return await webSearch.run(call, onProgress, signal);
  }

  private async delegate(
    { call, files }: AcceptedDelegation,
    { workspace, signal, onProgress }: AgentRun,
  ): Promise<ToolResult> {
    const fileCount = (files.length ? files : listTextFiles(workspace.files)).length;
    onProgress({ stage: 'delegating', task: call.task, fileCount });
    let lookups = 0;
    const subtask: AgentRun = {
      request: { kind: 'subtask', task: call.task, files: files.map((file) => file.path) },
      workspace,
      host: {
        viewHistory: () => NO_HISTORY,
        recordLookup: () => {
          lookups += 1;
        },
      },
      signal,
      onProgress: (progress) => {
        onProgress({ stage: 'subagent', fileCount, progress });
      },
    };
    let outcome: AgentOutcome;
    try {
      outcome = await this.run(subtask);
    } catch (error) {
      if (error instanceof AgentMistakeLimitError) {
        const problem = `the subagent stopped after ${String(AGENT_POLICY.maxConsecutiveMistakes)} invalid steps in a row (last: ${error.lastMistake.message})`;
        return { tool: AgentTool.Delegate, report: failDelegation(problem, lookups) };
      }
      if (error instanceof AssistantProtocolError) {
        const problem = `the subagent stopped: ${error.message}`;
        return { tool: AgentTool.Delegate, report: failDelegation(problem, lookups) };
      }
      throw error;
    }
    const { reply } = outcome;
    if (reply.kind !== 'answer') {
      throw new InvariantViolation(`a subagent replied with ${reply.kind}`);
    }
    return { tool: AgentTool.Delegate, report: finishDelegation(reply.text, lookups) };
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
