import type { ApplyDocumentChange } from '../application/apply-document-change';
import type { ConversationLog } from '../application/conversation-log';
import type { StartNewConversation } from '../application/conversation-session';
import type { HandleAssistantRequest } from '../application/handle-assistant-request';
import type { AgentProgress } from '../application/agent-progress';
import type { RejectDocumentChange } from '../application/reject-document-change';
import type { ReviewAppliedChange } from '../application/review-applied-change';
import { InvariantViolation, OperationalError } from '../domain/errors';
import type { AssistantView, ViewEvents } from './assistant-view';
import {
  appliedNotice,
  COMPILED,
  errorNotice,
  INTERNAL_ERROR,
  progressStatus,
  REJECTED,
} from './message-format';

export interface UseCases {
  handleRequest: HandleAssistantRequest;
  applyChange: ApplyDocumentChange;
  reviewChange: ReviewAppliedChange;
  rejectChange: RejectDocumentChange;
  startNewConversation: StartNewConversation;
  conversation: Pick<ConversationLog, 'restore' | 'takePersistenceFailure'>;
}

export class AssistantController implements ViewEvents {
  private view: AssistantView | null = null;

  constructor(private readonly useCases: UseCases) {}

  attach(view: AssistantView): Promise<void> {
    this.view = view;
    return this.guard(() => {
      view.showConversation(this.useCases.conversation.restore());
    });
  }

  send(text: string): Promise<void> {
    const view = this.requireView();
    let accepted = false;
    const run = async (): Promise<void> => {
      try {
        const result = await this.useCases.handleRequest.execute(text, (progress) => {
          if (progress.stage === 'received') {
            accepted = true;
            view.setBusy(true);
            view.clearInput();
          }
          this.showProgress(view, progress);
        });
        view.appendMessage(result.message, result.changeId);
      } finally {
        if (accepted) {
          view.setBusy(false);
          view.setStatus('');
        }
      }
    };
    return this.guard(run);
  }

  apply(changeId: string): Promise<void> {
    const view = this.requireView();
    view.closeChangeActions(changeId);
    const onProgress = (progress: AgentProgress): void => {
      this.showProgress(view, progress);
    };
    return this.guard(async () => {
      view.setBusy(true);
      try {
        const change = await this.useCases.applyChange.execute(changeId, onProgress);
        view.showNotice(appliedNotice(change), 'info');
        const outcome = await this.useCases.reviewChange.execute(onProgress);
        switch (outcome.kind) {
          case 'compiled':
            view.showNotice(COMPILED, 'info');
            break;
          case 'fix':
            view.appendMessage(outcome.result.message, outcome.result.changeId);
        }
      } finally {
        view.setBusy(false);
        view.setStatus('');
      }
    });
  }

  reject(changeId: string): Promise<void> {
    const view = this.requireView();
    view.closeChangeActions(changeId);
    return this.guard(() => {
      const { removedMessageId } = this.useCases.rejectChange.execute(changeId);
      view.removeMessage(removedMessageId);
      view.showNotice(REJECTED, 'info');
    });
  }

  newConversation(): Promise<void> {
    const view = this.requireView();
    return this.guard(() => {
      this.useCases.startNewConversation.execute();
      view.showConversation([]);
      view.clearInput();
    });
  }

  private showProgress(view: AssistantView, progress: AgentProgress): void {
    if (progress.stage === 'received') {
      view.closeAllChangeActions();
      view.appendMessage(progress.message);
    }
    view.setStatus(progressStatus(progress));
  }

  private async guard(action: () => void | Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (!(error instanceof OperationalError)) {
        this.requireView().showNotice(INTERNAL_ERROR, 'error');
        throw error;
      }
      this.requireView().showNotice(errorNotice(error.message), 'error');
    } finally {
      this.reportPersistence();
    }
  }

  private reportPersistence(): void {
    const failure = this.useCases.conversation.takePersistenceFailure();
    if (failure) this.requireView().showNotice(failure.message, 'error');
  }

  private requireView(): AssistantView {
    if (!this.view) throw new InvariantViolation('AssistantController used before attach()');
    return this.view;
  }
}
