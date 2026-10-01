import { DiagnosticLevel } from '../domain/agent-transcript';
import type { CancellationSignal } from '../ports/cancellation';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';
import type { ConversationLog } from './conversation-log';
import type { AgentResult, HandleAssistantRequest } from './handle-assistant-request';

export type ReviewOutcome =
  { readonly kind: 'compiled' } | { readonly kind: 'fix'; readonly result: AgentResult };

export class ReviewAppliedChange {
  constructor(
    private readonly deps: {
      project: ProjectPort;
      conversation: ConversationLog;
      handleRequest: HandleAssistantRequest;
    },
  ) {}

  async execute(
    onProgress: (progress: AgentProgress) => void,
    signal: CancellationSignal,
  ): Promise<ReviewOutcome> {
    const epoch = this.deps.conversation.epoch;
    onProgress({ stage: 'compiling' });
    const diagnostics = await this.deps.project.compile(signal);
    this.deps.conversation.ensureCurrent(epoch);
    if (!diagnostics.some((diagnostic) => diagnostic.level === DiagnosticLevel.Error)) {
      return { kind: 'compiled' };
    }
    const result = await this.deps.handleRequest.fixCompileErrors(diagnostics, onProgress, signal);
    return { kind: 'fix', result };
  }
}
