import { DiagnosticLevel } from '../domain/agent-transcript';
import type { CancellationSignal } from '../ports/cancellation';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';
import type { AgentResult, ConversationAgent } from './conversation-agent';
import { ensureNotCancelled } from './operation-lock';

export type ReviewOutcome =
  { readonly kind: 'compiled' } | { readonly kind: 'fix'; readonly result: AgentResult };

export class ReviewAppliedChange {
  constructor(
    private readonly deps: {
      project: ProjectPort;
      conversationAgent: ConversationAgent;
    },
  ) {}

  async execute(
    onProgress: (progress: AgentProgress) => void,
    signal: CancellationSignal,
  ): Promise<ReviewOutcome> {
    onProgress({ stage: 'compiling' });
    const diagnostics = await this.deps.project.compile(signal);
    ensureNotCancelled(signal);
    if (!diagnostics.some((diagnostic) => diagnostic.level === DiagnosticLevel.Error)) {
      return { kind: 'compiled' };
    }
    const result = await this.deps.conversationAgent.fixCompileErrors(
      diagnostics,
      onProgress,
      signal,
    );
    return { kind: 'fix', result };
  }
}
