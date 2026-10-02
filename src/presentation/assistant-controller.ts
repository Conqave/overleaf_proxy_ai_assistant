import type { ApplyChangeSet } from '../application/apply-change-set';
import type { ChangeSetOutcome } from '../application/change-set-outcome';
import type { CompactConversation } from '../application/compact-conversation';
import type { ConversationLog } from '../application/conversation-log';
import type {
  DeleteSession,
  ListSessions,
  OpenSession,
  RestoreLatestSession,
  StartNewConversation,
} from '../application/conversation-session';
import type { AgentResult } from '../application/conversation-agent';
import type { HandleAssistantRequest } from '../application/handle-assistant-request';
import type { ReadContextUsage } from '../application/read-context-usage';
import type { ContextUsage } from '../domain/context-usage';
import type { AgentProgress } from '../application/agent-progress';
import { RequestSupersededError } from '../application/errors';
import type { OperationLock } from '../application/operation-lock';
import type { PreviewChangeSetFile } from '../application/preview-change-set-file';
import type {
  ExportSession,
  ImportSession,
  ListSessionExports,
} from '../application/session-exchange';
import type { RejectChangeSet } from '../application/reject-change-set';
import type { UndoChangeSet } from '../application/undo-change-set';
import type { WebSearchApproval, WebSearchDecision } from '../application/web-search-approval';
import type { Notice } from '../domain/conversation';
import { InvariantViolation, OperationalError } from '../domain/errors';
import type { AssistantView } from './assistant-view';
import type { ViewEvents } from './view-events';
import { contextUsageText, INTERNAL_ERROR, noticeText, progressStatus } from './message-format';

interface UseCases {
  handleRequest: HandleAssistantRequest;
  readContextUsage: ReadContextUsage;
  applyChange: ApplyChangeSet;
  lock: Pick<OperationLock, 'onChange'>;
  rejectChange: RejectChangeSet;
  previewChange: PreviewChangeSetFile;
  undoChange: UndoChangeSet;
  restoreSession: RestoreLatestSession;
  startNewConversation: StartNewConversation;
  compactConversation: CompactConversation;
  listSessions: ListSessions;
  openSession: OpenSession;
  deleteSession: DeleteSession;
  exportSession: ExportSession;
  listSessionExports: ListSessionExports;
  importSession: ImportSession;
  webSearchApproval: Pick<WebSearchApproval, 'decide'>;
  conversation: Pick<ConversationLog, 'epoch' | 'messages' | 'takePersistenceFailure'>;
}

export class AssistantController implements ViewEvents {
  private view: AssistantView | null = null;

  constructor(private readonly useCases: UseCases) {}

  attach(view: AssistantView): Promise<void> {
    this.view = view;
    this.useCases.lock.onChange((busy) => {
      view.setBusy(busy);
      if (!busy) this.showCompactable(view);
    });
    return this.guard(async () => {
      try {
        await this.useCases.restoreSession.execute();
      } finally {
        this.showConversation(view);
      }
    });
  }

  compact(): Promise<void> {
    const view = this.requireView();
    return this.guard(async () => {
      try {
        await this.useCases.compactConversation.execute((progress) => {
          this.showProgress(view, progress);
        });
      } finally {
        view.setStatus('');
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

  apply(proposalId: string, index: number | null): Promise<void> {
    return this.decide((onProgress) =>
      this.useCases.applyChange.execute(proposalId, indexesOf(index), onProgress),
    );
  }

  reject(proposalId: string, index: number | null): Promise<void> {
    return this.decide((onProgress) =>
      this.useCases.rejectChange.execute(proposalId, indexesOf(index), onProgress),
    );
  }

  previewFile(proposalId: string, path: string): Promise<void> {
    const view = this.requireView();
    return this.guard(async () => {
      try {
        await this.useCases.previewChange.execute(proposalId, path, (progress) => {
          this.showProgress(view, progress);
        });
      } finally {
        view.setStatus('');
      }
    });
  }

  undo(proposalId: string): Promise<void> {
    const view = this.requireView();
    return this.guard(async () => {
      try {
        const { message } = await this.useCases.undoChange.execute(proposalId, (progress) => {
          this.showProgress(view, progress);
        });
        view.updateMessage(message);
      } finally {
        view.setStatus('');
      }
    });
  }

  decideWebSearch(id: string, decision: WebSearchDecision): Promise<void> {
    return this.guard(() => {
      this.useCases.webSearchApproval.decide(id, decision);
    });
  }

  private decide(
    decision: (onProgress: (progress: AgentProgress) => void) => Promise<ChangeSetOutcome>,
  ): Promise<void> {
    const view = this.requireView();
    return this.guard(async () => {
      try {
        const { message, review } = await decision((progress) => {
          this.showProgress(view, progress);
        });
        view.updateMessage(message);
        if (review?.kind === 'fix') this.showResult(view, review.result);
      } finally {
        view.setStatus('');
      }
    });
  }

  newConversation(): Promise<void> {
    const view = this.requireView();
    return this.guard(async () => {
      await this.useCases.startNewConversation.execute();
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

  exportSession(id: string): Promise<void> {
    const view = this.requireView();
    return this.guard(async () => {
      const path = await this.useCases.exportSession.execute(id);
      showNotice(view, { kind: 'exported', path });
    });
  }

  showImports(): Promise<void> {
    const view = this.requireView();
    return this.guard(() => {
      view.showImportList(this.useCases.listSessionExports.execute());
    });
  }

  importSession(path: string): Promise<void> {
    const view = this.requireView();
    return this.guard(async () => {
      await this.replacingConversation(view, () => this.useCases.importSession.execute(path));
      view.closeSessionList();
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
    this.showStoredContextUsage(view);
    this.showCompactable(view);
  }

  private showStoredContextUsage(view: AssistantView): void {
    this.showContextUsage(view, this.useCases.readContextUsage.execute());
  }

  private showCompactable(view: AssistantView): void {
    view.setCompactable(this.useCases.compactConversation.canCompact());
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
        view.appendMessage(result.message);
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
        break;
      case 'compacted':
      case 'recorded':
      case 'noted':
        view.appendMessage(progress.message);
        break;
      case 'measured':
        this.showContextUsage(view, progress.contextUsage);
        break;
      case 'awaiting-approval':
        view.showWebSearchApproval(progress.search);
        break;
      case 'approval-decided':
        view.removeWebSearchApproval(progress.id);
        break;
      case 'thinking':
      case 'reading':
      case 'searching':
      case 'compiling':
      case 'searching-web':
      case 'delegating':
      case 'opening':
      case 'compacting':
      case 'subagent':
        break;
    }
    const status = progressStatus(progress);
    if (status !== null) view.setStatus(status);
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
      showNotice(this.requireView(), { kind: 'failed', problem: error.message });
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

function indexesOf(index: number | null): readonly number[] | null {
  return index === null ? null : [index];
}

function showNotice(view: AssistantView, notice: Notice): void {
  const { text, tone } = noticeText(notice);
  view.showNotice(text, tone);
}
