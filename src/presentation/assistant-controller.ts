import type { ApplyDocumentChange } from '../application/apply-document-change';
import type { ConversationLog } from '../application/conversation-log';
import type { StartNewConversation } from '../application/conversation-session';
import type { HandleAssistantRequest } from '../application/handle-assistant-request';
import type { RejectDocumentChange } from '../application/reject-document-change';
import { InvariantViolation, OperationalError } from '../domain/errors';
import type { AssistantView, ViewEvents } from './assistant-view';
import { appliedNotice, INTERNAL_ERROR, progressStatus, REJECTED } from './message-format';

export interface UseCases {
  handleRequest: HandleAssistantRequest;
  applyChange: ApplyDocumentChange;
  rejectChange: RejectDocumentChange;
  startNewConversation: StartNewConversation;
  conversation: Pick<ConversationLog, 'restore' | 'takePersistenceFailure'>;
}

export class AssistantController implements ViewEvents {
  private view: AssistantView | null = null;

  constructor(private readonly useCases: UseCases) {}

  attach(view: AssistantView): void {
    this.view = view;
    this.guard(() => {
      view.showConversation(this.useCases.conversation.restore());
    });
  }

  send(text: string): void {
    const view = this.requireView();
    let accepted = false;
    const run = async (): Promise<void> => {
      try {
        const result = await this.useCases.handleRequest.execute(text, (progress) => {
          if (progress.stage === 'received') {
            accepted = true;
            view.setBusy(true);
            view.closeAllChangeActions();
            view.clearInput();
            view.appendMessage(progress.message);
          }
          view.setStatus(progressStatus(progress));
        });
        view.appendMessage(result.message, result.changeId);
      } finally {
        if (accepted) {
          view.setBusy(false);
          view.setStatus('');
        }
      }
    };
    void this.guardAsync(run);
  }

  apply(changeId: string): void {
    const view = this.requireView();
    view.closeChangeActions(changeId);
    this.guard(() => {
      const command = this.useCases.applyChange.execute(changeId);
      view.showNotice(appliedNotice(command), 'info');
    });
  }

  reject(changeId: string): void {
    const view = this.requireView();
    view.closeChangeActions(changeId);
    this.guard(() => {
      const { removedMessageId } = this.useCases.rejectChange.execute(changeId);
      view.removeMessage(removedMessageId);
      view.showNotice(REJECTED, 'info');
    });
  }

  newConversation(): void {
    const view = this.requireView();
    this.guard(() => {
      this.useCases.startNewConversation.execute();
      view.showConversation([]);
      view.clearInput();
    });
  }

  private guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      if (!(error instanceof OperationalError)) {
        this.requireView().showNotice(INTERNAL_ERROR, 'error');
        throw error;
      }
      this.requireView().showNotice(`Error: ${error.message}`, 'error');
    } finally {
      this.reportPersistence();
    }
  }

  private async guardAsync(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (!(error instanceof OperationalError)) {
        this.requireView().showNotice(INTERNAL_ERROR, 'error');
        throw error;
      }
      this.requireView().showNotice(`Error: ${error.message}`, 'error');
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
