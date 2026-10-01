import type { ApplyDocumentChange } from '../application/apply-document-change';
import type { ConversationLog } from '../application/conversation-log';
import type {
  RestoreLatestSession,
  StartNewConversation,
} from '../application/conversation-session';
import type { AgentResult, HandleAssistantRequest } from '../application/handle-assistant-request';
import type { AgentProgress } from '../application/agent-progress';
import { RequestSupersededError } from '../application/errors';
import type { OperationLock } from '../application/operation-lock';
import type { RejectDocumentChange } from '../application/reject-document-change';
import { ProposalStatus } from '../domain/conversation';
import { InvariantViolation, OperationalError } from '../domain/errors';
import type { AssistantView, ViewEvents } from './assistant-view';
import {
  appliedNotice,
  COMPILED,
  contextUsageText,
  errorNotice,
  INTERNAL_ERROR,
  progressStatus,
} from './message-format';

export interface UseCases {
  handleRequest: HandleAssistantRequest;
  applyChange: ApplyDocumentChange;
  lock: Pick<OperationLock, 'onChange'>;
  rejectChange: RejectDocumentChange;
  restoreSession: RestoreLatestSession;
  startNewConversation: StartNewConversation;
  conversation: Pick<ConversationLog, 'takePersistenceFailure'>;
}

export class AssistantController implements ViewEvents {
  private view: AssistantView | null = null;

  constructor(private readonly useCases: UseCases) {}

  attach(view: AssistantView): Promise<void> {
    this.view = view;
    this.showUnusedContext(view);
    this.useCases.lock.onChange((busy) => {
      view.setBusy(busy);
    });
    return this.guard(async () => {
      view.showConversation(await this.useCases.restoreSession.execute());
    });
  }

  send(text: string): Promise<void> {
    const view = this.requireView();
    return this.guard(async () => {
      try {
        const result = await this.useCases.handleRequest.execute(text, (progress) => {
          if (progress.stage === 'received') view.clearInput();
          this.showProgress(view, progress);
        });
        this.showResult(view, result);
      } finally {
        view.setStatus('');
      }
    });
  }

  apply(changeId: string): Promise<void> {
    const view = this.requireView();
    const onProgress = (progress: AgentProgress): void => {
      this.showProgress(view, progress);
    };
    return this.guard(async () => {
      try {
        const outcome = await this.useCases.applyChange.execute(changeId, onProgress);
        switch (outcome.kind) {
          case 'compiled':
            view.showNotice(COMPILED, 'info');
            break;
          case 'fix':
            this.showResult(view, outcome.result);
        }
      } finally {
        view.setStatus('');
      }
    });
  }

  reject(changeId: string): Promise<void> {
    const view = this.requireView();
    return this.guard(async () => {
      view.updateMessage(await this.useCases.rejectChange.execute(changeId));
    });
  }

  newConversation(): Promise<void> {
    const view = this.requireView();
    return this.guard(() => {
      this.useCases.startNewConversation.execute();
      view.showConversation([]);
      this.showUnusedContext(view);
      view.clearInput();
    });
  }

  private showUnusedContext(view: AssistantView): void {
    view.setContextUsage(contextUsageText(this.useCases.handleRequest.getUnusedContext()));
  }

  private showResult(view: AssistantView, result: AgentResult): void {
    switch (result.kind) {
      case 'reply':
        view.appendMessage(result.message);
        view.setContextUsage(contextUsageText(result.contextUsage));
        break;
      case 'proposal':
        view.appendMessage(result.message, result.changeId);
        view.setContextUsage(contextUsageText(result.contextUsage));
    }
  }

  private showProgress(view: AssistantView, progress: AgentProgress): void {
    switch (progress.stage) {
      case 'received':
        view.appendMessage(progress.message);
        break;
      case 'decided':
        view.updateMessage(progress.message);
        if (progress.message.status === ProposalStatus.Applied) {
          view.showNotice(appliedNotice(progress.message), 'info');
        }
        break;
      case 'thinking':
      case 'reading':
      case 'searching':
      case 'compiling':
      case 'opening':
        break;
    }
    view.setStatus(progressStatus(progress));
  }

  private async guard(action: () => void | Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (error instanceof RequestSupersededError) return;
      if (!(error instanceof OperationalError)) {
        this.requireView().showNotice(INTERNAL_ERROR, 'error');
        throw error;
      }
      this.requireView().showNotice(errorNotice(error.message), 'error');
    } finally {
      await this.reportPersistence();
    }
  }

  private async reportPersistence(): Promise<void> {
    const failure = await this.useCases.conversation.takePersistenceFailure();
    if (failure) this.requireView().showNotice(failure.message, 'error');
  }

  private requireView(): AssistantView {
    if (!this.view) throw new InvariantViolation('AssistantController used before attach()');
    return this.view;
  }
}
