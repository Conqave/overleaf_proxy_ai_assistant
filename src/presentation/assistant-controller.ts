import type { ApplyDocumentChange } from '../application/apply-document-change';
import type { ConversationLog } from '../application/conversation-log';
import type {
  DeleteSession,
  ListSessions,
  OpenSession,
  RestoreLatestSession,
  StartNewConversation,
} from '../application/conversation-session';
import type {
  AgentResult,
  ContextUsage,
  HandleAssistantRequest,
} from '../application/handle-assistant-request';
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
  listSessions: ListSessions;
  openSession: OpenSession;
  deleteSession: DeleteSession;
  conversation: Pick<ConversationLog, 'epoch' | 'messages' | 'takePersistenceFailure'>;
}

export class AssistantController implements ViewEvents {
  private view: AssistantView | null = null;

  constructor(private readonly useCases: UseCases) {}

  attach(view: AssistantView): Promise<void> {
    this.view = view;
    this.useCases.lock.onChange((busy) => {
      view.setBusy(busy);
    });
    return this.guard(async () => {
      try {
        await this.useCases.restoreSession.execute();
      } finally {
        this.showConversation(view);
      }
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
      view.closeSessionList();
      this.showConversation(view);
      view.clearInput();
    });
  }

  showSessions(): Promise<void> {
    const view = this.requireView();
    return this.guard(async () => {
      view.showSessionList(await this.useCases.listSessions.execute());
    });
  }

  openSession(id: string): Promise<void> {
    const view = this.requireView();
    return this.guard(async () => {
      await this.replacingConversation(view, () => this.useCases.openSession.execute(id));
      view.closeSessionList();
    });
  }

  deleteSession(id: string): Promise<void> {
    const view = this.requireView();
    return this.guard(async () => {
      await this.replacingConversation(view, () => this.useCases.deleteSession.execute(id));
      view.showSessionList(await this.useCases.listSessions.execute());
    });
  }

  private async replacingConversation(
    view: AssistantView,
    replace: () => Promise<void>,
  ): Promise<void> {
    const epoch = this.useCases.conversation.epoch;
    try {
      await replace();
    } finally {
      if (this.useCases.conversation.epoch !== epoch) this.showConversation(view);
    }
  }

  private showConversation(view: AssistantView): void {
    view.showConversation(this.useCases.conversation.messages());
    this.showUnusedContext(view);
  }

  private showUnusedContext(view: AssistantView): void {
    this.showContextUsage(view, this.useCases.handleRequest.getUnusedContext());
  }

  private showContextUsage(view: AssistantView, usage: ContextUsage): void {
    view.setContextUsage(contextUsageText(usage), usage.pressure);
  }

  private showResult(view: AssistantView, result: AgentResult): void {
    switch (result.kind) {
      case 'reply':
        view.appendMessage(result.message);
        this.showContextUsage(view, result.contextUsage);
        break;
      case 'proposal':
        view.appendMessage(result.message, result.changeId);
        this.showContextUsage(view, result.contextUsage);
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
