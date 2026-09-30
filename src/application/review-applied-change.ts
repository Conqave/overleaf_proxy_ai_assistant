import { AgentTool } from '../domain/agent-action';
import { DiagnosticLevel } from '../domain/agent-transcript';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import { RequestSupersededError } from './errors';
import type { AssistantRequestResult, HandleAssistantRequest } from './handle-assistant-request';

export const FIX_REQUEST = 'Compilation after the change reports errors; propose a fix.';

export type ReviewOutcome =
  { readonly kind: 'compiled' } | { readonly kind: 'fix'; readonly result: AssistantRequestResult };

export class ReviewAppliedChange {
  constructor(
    private readonly deps: {
      project: ProjectPort;
      conversation: ConversationLog;
      handleRequest: HandleAssistantRequest;
    },
  ) {}

  async execute(onProgress: (progress: AgentProgress) => void): Promise<ReviewOutcome> {
    const epoch = this.deps.conversation.epoch;
    onProgress({ stage: 'compiling' });
    const diagnostics = await this.deps.project.compile();
    if (this.deps.conversation.epoch !== epoch) throw new RequestSupersededError();
    if (!diagnostics.some((diagnostic) => diagnostic.level === DiagnosticLevel.Error)) {
      return { kind: 'compiled' };
    }
    const result = await this.deps.handleRequest.execute(FIX_REQUEST, onProgress, [
      { call: { tool: AgentTool.Compile }, result: { tool: AgentTool.Compile, diagnostics } },
    ]);
    return { kind: 'fix', result };
  }
}
