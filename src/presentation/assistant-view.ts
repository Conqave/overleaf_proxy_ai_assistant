import type { SessionList } from '../application/conversation-session';
import {
  canUndoEdits,
  EditStatus,
  findPendingEdits,
  groupEditsByPath,
  type FileEdits,
  type ProposedEdit,
} from '../domain/change-set';
import {
  AssistantMessageKind,
  type AssistantMessage,
  type ChatMessage,
  type CompactionSummaryMessage,
  type ConversationMessage,
  type ProposalMessage,
  type ToolMessage,
  type NoticeMessage,
  type UndoMessage,
} from '../domain/conversation';
import { AgentTool } from '../domain/agent-action';
import type { DelegateRecord, WebSearchRecord } from '../domain/agent-transcript';
import { WebSearchStatus } from '../domain/web-search';
import {
  AutoApprovalScope,
  WebSearchDecision,
  type PendingWebSearch,
} from '../application/web-search-approval';
import { DelegationOutcome } from '../domain/delegation';
import { DocumentOperation } from '../domain/document-command';
import type { ContextPressure } from '../domain/context-usage';
import type { SessionSummary } from '../domain/session';
import css from './assistant.css?raw';
import { InvariantViolation } from '../domain/errors';
import { MarkdownRenderer } from './markdown-renderer';
import { PanelResizer } from './panel-resizer';
import type { PanelSizeStore } from '../ports/panel-size-store';
import {
  changeSetStatusText,
  compactionFiles,
  compactionNotice,
  delegationMeta,
  delegationTitle,
  editLinesMeta,
  editStatusText,
  exportFileName,
  getSharedStatus,
  messageMeta,
  messageTitle,
  sessionDetails,
  undoNotice,
  undoRefusalNotice,
  AUTO_APPROVAL_TEXT,
  VIEW_TEXT,
  webResultSource,
  webSearchMeta,
  webSearchTitle,
  noticeText,
  type NoticeText,
  type NoticeTone,
} from './message-format';

interface AutoApprovalOption {
  readonly input: HTMLInputElement;
  readonly label: HTMLElement;
  readonly decision: WebSearchDecision;
}

const AUTO_APPROVAL_DECISION: Record<AutoApprovalScope, WebSearchDecision> = {
  [AutoApprovalScope.Request]: WebSearchDecision.ApproveForRequest,
  [AutoApprovalScope.Session]: WebSearchDecision.ApproveForSession,
};

interface ShownToolMessage extends ToolMessage {
  readonly record: DelegateRecord | WebSearchRecord;
}

type ShownMessage =
  ChatMessage | CompactionSummaryMessage | UndoMessage | NoticeMessage | ShownToolMessage;

function isShownMessage(message: ConversationMessage): message is ShownMessage {
  if (message.role !== 'tool') return true;
  switch (message.record.tool) {
    case AgentTool.Delegate:
    case AgentTool.WebSearch:
      return true;
    case AgentTool.ReadFile:
    case AgentTool.Search:
    case AgentTool.Compile:
      return false;
  }
}

export interface ViewEvents {
  send(text: string): Promise<void>;
  apply(proposalId: string, index: number | null): Promise<void>;
  reject(proposalId: string, index: number | null): Promise<void>;
  previewFile(proposalId: string, path: string): Promise<void>;
  undo(proposalId: string): Promise<void>;
  newConversation(): Promise<void>;
  showSessions(): Promise<void>;
  openSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  exportSession(id: string): Promise<void>;
  showImports(): Promise<void>;
  importSession(path: string): Promise<void>;
  compact(): Promise<void>;
  decideWebSearch(id: string, decision: WebSearchDecision): Promise<void>;
}

const ROOT_ID = 'ola-root';

const PRESSURE_CLASS: Record<ContextPressure, string> = {
  low: 'is-low',
  elevated: 'is-elevated',
  high: 'is-high',
};
const STYLE_ID = 'ola-style';

export class AssistantView {
  private readonly root: HTMLElement;
  private readonly chat: HTMLElement;
  private readonly sessionList: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly typing: HTMLElement;
  private readonly contextUsage: HTMLElement;
  private readonly markdown: MarkdownRenderer;
  private readonly compactButton: HTMLButtonElement;
  private compactable = false;
  private readonly messageNodes = new Map<string, HTMLElement>();
  private busy = false;
  private readonly proposalCards = new Map<string, HTMLElement>();
  private readonly approvalCards = new Map<string, HTMLElement>();

  static isMounted(document: Document): boolean {
    return document.getElementById(ROOT_ID) !== null;
  }

  constructor(
    private readonly document: Document,
    private readonly events: ViewEvents,
    panelSize: PanelSizeStore,
  ) {
    this.markdown = new MarkdownRenderer(document);
    this.injectStyles();
    this.root = this.el('div');
    this.root.id = ROOT_ID;

    const badge = this.el('button', 'ola-badge', VIEW_TEXT.badge);
    badge.type = 'button';
    badge.prepend(this.el('span', 'ola-dot'));
    badge.addEventListener('click', () => this.root.classList.toggle('is-collapsed'));

    const head = this.el('div', 'ola-head');
    const newButton = this.el('button', 'ola-head-btn ola-new-chat', VIEW_TEXT.newChat);
    newButton.type = 'button';
    newButton.title = VIEW_TEXT.newChatHint;
    newButton.addEventListener('click', () => {
      void this.events.newConversation();
    });
    const sessionsButton = this.el(
      'button',
      'ola-head-btn ola-sessions-toggle',
      VIEW_TEXT.sessions,
    );
    sessionsButton.type = 'button';
    sessionsButton.title = VIEW_TEXT.sessionsHint;
    sessionsButton.addEventListener('click', () => {
      if (this.sessionList.classList.contains('is-open')) {
        this.closeSessionList();
        return;
      }
      void this.events.showSessions();
    });
    this.contextUsage = this.el('span', 'ola-context');
    this.contextUsage.title = VIEW_TEXT.contextHint;
    this.compactButton = this.el('button', 'ola-head-btn ola-compact', VIEW_TEXT.compact);
    this.compactButton.type = 'button';
    this.compactButton.title = VIEW_TEXT.compactHint;
    this.compactButton.disabled = true;
    this.compactButton.addEventListener('click', () => {
      void this.events.compact();
    });
    const titleRow = this.el('div', 'ola-head-row');
    titleRow.append(this.el('span', 'ola-title', VIEW_TEXT.title), this.contextUsage);
    const actions = this.el('div', 'ola-head-actions');
    actions.append(this.compactButton, sessionsButton, newButton);
    head.append(titleRow, actions);

    this.sessionList = this.el('div', 'ola-sessions');
    this.chat = this.el('div', 'ola-chat');

    this.status = this.el('div', 'ola-status is-empty');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    const dots = this.el('span', 'ola-typing-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(this.el('span'), this.el('span'), this.el('span'));
    this.typing = this.el('div', 'ola-typing');
    this.typing.hidden = true;
    this.typing.append(dots, this.status);
    this.chat.append(this.typing);
    this.input = this.el('textarea', 'ola-textarea');
    this.input.placeholder = VIEW_TEXT.inputPlaceholder;
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.submit();
      }
    });
    const label = this.el('label', 'ola-label');
    label.append(this.el('span', undefined, VIEW_TEXT.inputLabel), this.input);

    this.sendButton = this.el('button', 'ola-btn ola-send', VIEW_TEXT.send);
    this.sendButton.type = 'button';
    this.sendButton.addEventListener('click', () => {
      this.submit();
    });
    const body = this.el('div', 'ola-body');
    body.append(label, this.sendButton);
    const panel = this.el('section', 'ola-panel');
    const resizer = new PanelResizer(windowOf(document), panel, panelSize);
    panel.append(resizer.handle, head, this.sessionList, this.chat, body);
    this.root.append(panel, badge);
    document.body.appendChild(this.root);
  }

  showConversation(messages: readonly ConversationMessage[]): void {
    this.chat.replaceChildren(this.typing);
    this.messageNodes.clear();
    this.proposalCards.clear();
    this.approvalCards.clear();
    const chat = messages.filter(isShownMessage);
    if (!chat.length) {
      this.showWelcome();
      return;
    }
    for (const message of chat) this.appendMessage(message);
  }

  appendMessage(message: ConversationMessage): void {
    if (!isShownMessage(message)) return;
    this.chat.querySelector('.ola-welcome')?.remove();
    const node = this.renderMessage(message);
    this.messageNodes.set(message.id, node);
    this.append(node);
  }

  updateMessage(message: ChatMessage): void {
    const shown = this.messageNodes.get(message.id);
    if (shown === undefined)
      throw new InvariantViolation(`the chat shows no message ${message.id}`);
    this.proposalCards.delete(message.id);
    const node = this.renderMessage(message);
    shown.replaceWith(node);
    this.messageNodes.set(message.id, node);
  }

  showWebSearchApproval({ id, query, autoApprovalScopes }: PendingWebSearch): void {
    const node = this.el('div', 'ola-msg ola-ai ola-approval');
    const options = autoApprovalScopes.map((scope) => this.autoApprovalOption(scope));
    for (const { input } of options) {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        for (const other of options) if (other.input !== input) other.input.checked = false;
      });
    }
    const chosen = (): WebSearchDecision => {
      const checked = options.find(({ input }) => input.checked);
      return checked === undefined ? WebSearchDecision.Approve : checked.decision;
    };
    const decide = (decision: WebSearchDecision): void => {
      for (const control of node.querySelectorAll('button, input')) {
        control.setAttribute('disabled', '');
      }
      void this.events.decideWebSearch(id, decision);
    };
    const approve = this.el('button', 'ola-btn ola-approve-search', VIEW_TEXT.approve);
    approve.type = 'button';
    approve.addEventListener('click', () => {
      decide(chosen());
    });
    const deny = this.el('button', 'ola-btn ola-deny-search', VIEW_TEXT.deny);
    deny.type = 'button';
    deny.addEventListener('click', () => {
      decide(WebSearchDecision.Deny);
    });
    const actions = this.el('div', 'ola-result-actions');
    actions.append(approve, deny);
    node.append(
      this.el('div', 'ola-result-title', VIEW_TEXT.approvalTitle),
      this.el('div', 'ola-result-body ola-approval-query', query),
      this.el('div', 'ola-result-meta', VIEW_TEXT.approvalNote),
      ...options.map(({ label }) => label),
      ...(options.length ? [this.el('div', 'ola-result-meta', VIEW_TEXT.autoApprovalNote)] : []),
      actions,
    );
    this.chat.querySelector('.ola-welcome')?.remove();
    this.approvalCards.set(id, node);
    this.append(node);
  }

  private autoApprovalOption(scope: AutoApprovalScope): AutoApprovalOption {
    const input = this.el('input', `ola-approval-${scope}`);
    input.type = 'checkbox';
    const label = this.el('label', 'ola-approval-option');
    label.append(input, this.el('span', undefined, AUTO_APPROVAL_TEXT[scope]));
    return { input, label, decision: AUTO_APPROVAL_DECISION[scope] };
  }

  removeWebSearchApproval(id: string): void {
    this.approvalCards.get(id)?.remove();
    this.approvalCards.delete(id);
  }

  showSessionList({ sessions, unreadableIds, currentId }: SessionList): void {
    this.sessionList.textContent = '';
    const head = this.el('div', 'ola-sessions-head');
    const importButton = this.sessionButton('ola-imports-toggle', VIEW_TEXT.showImports);
    importButton.title = VIEW_TEXT.showImportsHint;
    importButton.addEventListener('click', () => {
      void this.events.showImports();
    });
    head.append(this.el('div', 'ola-sessions-title', VIEW_TEXT.sessionsTitle), importButton);
    this.sessionList.append(head);
    if (sessions.length || unreadableIds.length) {
      const rows = this.el('ul', 'ola-session-list');
      for (const session of sessions) rows.append(this.renderSession(session, currentId));
      for (const id of unreadableIds) rows.append(this.renderUnreadableSession(id));
      this.sessionList.append(rows);
    } else {
      this.sessionList.append(this.el('div', 'ola-sessions-empty', VIEW_TEXT.noSessions));
    }
    this.sessionList.classList.add('is-open');
    this.setSessionButtonsBusy();
  }

  showImportList(paths: readonly string[]): void {
    this.sessionList.querySelector('.ola-imports')?.remove();
    const section = this.el('div', 'ola-imports');
    section.append(this.el('div', 'ola-sessions-title', VIEW_TEXT.importsTitle));
    if (paths.length) {
      const rows = this.el('ul', 'ola-session-list');
      for (const path of paths) rows.append(this.renderImport(path));
      section.append(rows);
    } else {
      section.append(this.el('div', 'ola-sessions-empty', VIEW_TEXT.noImports));
    }
    section.append(this.el('div', 'ola-sessions-empty', VIEW_TEXT.importsReloadHint));
    this.sessionList.querySelector('.ola-sessions-head')?.after(section);
    this.setSessionButtonsBusy();
  }

  closeSessionList(): void {
    this.sessionList.classList.remove('is-open');
    this.sessionList.textContent = '';
  }

  showNotice(text: string, tone: NoticeTone): void {
    this.append(this.renderNotice({ text, tone }));
  }

  private renderNotice({ text, tone }: NoticeText): HTMLElement {
    return this.el('div', `ola-msg ${tone === 'error' ? 'ola-error' : 'ola-system'}`, text);
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.root.classList.toggle('is-busy', busy);
    this.typing.hidden = !busy;
    if (busy) this.scrollToBottom();
    this.sendButton.disabled = busy;
    this.compactButton.disabled = busy || !this.compactable;
    for (const card of this.proposalCards.values()) {
      for (const action of card.querySelectorAll('button')) action.disabled = busy;
    }
    this.setSessionButtonsBusy();
  }

  setCompactable(compactable: boolean): void {
    this.compactable = compactable;
    this.compactButton.disabled = this.busy || !compactable;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
    this.status.classList.toggle('is-empty', !text);
    if (this.busy) this.scrollToBottom();
  }

  setContextUsage(text: string, pressure: ContextPressure): void {
    this.contextUsage.textContent = text;
    for (const [level, className] of Object.entries(PRESSURE_CLASS)) {
      this.contextUsage.classList.toggle(className, level === pressure);
    }
  }

  clearInput(): void {
    this.input.value = '';
    this.input.focus();
  }

  private submit(): void {
    if (this.busy) return;
    void this.events.send(this.input.value);
  }

  private renderMessage(message: ShownMessage): HTMLElement {
    switch (message.role) {
      case 'summary':
        return this.renderSummary(message);
      case 'undo':
        return this.renderUndo(message);
      case 'notice':
        return this.renderNotice(noticeText(message.notice));
      case 'user':
        return this.el('div', 'ola-msg ola-user', message.text);
      case 'system':
        return this.el('div', 'ola-msg ola-system', message.text);
      case 'assistant':
        return this.renderAssistant(message);
      case 'tool':
        return this.renderToolRecord(message.record);
    }
  }

  private renderToolRecord(record: DelegateRecord | WebSearchRecord): HTMLElement {
    switch (record.tool) {
      case AgentTool.Delegate:
        return this.renderDelegation(record);
      case AgentTool.WebSearch:
        return this.renderWebSearch(record);
    }
  }

  private renderWebSearch(record: WebSearchRecord): HTMLElement {
    const node = this.fold('ola-web-search');
    const title = webSearchTitle(record);
    const summary = this.el('summary', 'ola-fold-title ola-web-search-title', title);
    summary.title = title;
    node.append(summary);
    const { outcome } = record;
    switch (outcome.status) {
      case WebSearchStatus.Found: {
        const list = this.el('ol', 'ola-fold-body ola-web-results');
        for (const result of outcome.results) {
          const link = this.el('a', 'ola-web-link', result.title);
          link.href = result.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          const item = this.el('li', 'ola-web-result');
          item.append(link, this.el('div', 'ola-web-source', webResultSource(result)));
          list.append(item);
        }
        node.append(list);
        break;
      }
      case WebSearchStatus.Denied:
        node.classList.add('is-denied');
        break;
      case WebSearchStatus.Failed:
        node.classList.add('is-failed');
        node.append(this.el('div', 'ola-fold-body', outcome.problem));
    }
    const meta = webSearchMeta(record);
    if (meta !== undefined) node.append(this.el('div', 'ola-result-meta', meta));
    return node;
  }

  private renderAssistant(message: AssistantMessage): HTMLElement {
    const node = this.el('div', 'ola-msg ola-ai');
    node.append(this.el('div', 'ola-result-title', messageTitle(message)));
    switch (message.kind) {
      case AssistantMessageKind.Proposal:
        this.renderProposal(node, message);
        break;
      case AssistantMessageKind.Explanation:
      case AssistantMessageKind.Clarification:
        node.append(this.renderMarkdown('ola-result-body', message.text));
    }
    const meta = messageMeta(message);
    if (meta !== undefined) node.append(this.el('div', 'ola-result-meta', meta));
    if (message.kind === AssistantMessageKind.Proposal) {
      const actions = this.renderCardActions(message);
      if (actions !== null) node.append(actions);
      this.proposalCards.set(message.id, node);
    }
    return node;
  }

  private renderMarkdown(className: string, text: string): HTMLElement {
    const node = this.el('div', `${className} ola-markdown`);
    node.append(this.markdown.render(text));
    return node;
  }

  private renderUndo(message: UndoMessage): HTMLElement {
    const node = this.el('div', 'ola-msg ola-system ola-undo-notice');
    node.append(this.el('div', undefined, undoNotice(message)));
    for (const refusal of message.refused) {
      node.append(this.el('div', 'ola-error', undoRefusalNotice(refusal)));
    }
    return node;
  }

  private renderSummary(message: CompactionSummaryMessage): HTMLElement {
    const node = this.fold('ola-compaction');
    node.append(
      this.el('summary', 'ola-fold-title ola-compaction-title', compactionNotice(message)),
      this.renderMarkdown('ola-fold-body ola-compaction-body', message.text),
      this.el('div', 'ola-result-meta', compactionFiles(message)),
    );
    return node;
  }

  private renderDelegation(record: DelegateRecord): HTMLElement {
    const node = this.fold('ola-delegation');
    const title = delegationTitle(record);
    const summary = this.el('summary', 'ola-fold-title ola-delegation-title', title);
    summary.title = title;
    node.append(summary);
    const { report } = record;
    switch (report.outcome) {
      case DelegationOutcome.Finished:
        node.append(this.renderMarkdown('ola-fold-body ola-delegation-body', report.text));
        break;
      case DelegationOutcome.Failed:
        node.classList.add('is-failed');
        node.append(this.el('div', 'ola-fold-body ola-delegation-body', report.problem));
    }
    node.append(this.el('div', 'ola-result-meta', delegationMeta(record)));
    return node;
  }

  private fold(className: string): HTMLDetailsElement {
    const node = this.el('details', `ola-msg ola-system ola-fold ${className}`);
    node.addEventListener('toggle', () => {
      if (node.open) this.revealBottomOf(node);
    });
    return node;
  }

  private revealBottomOf(node: HTMLElement): void {
    const hiddenBelow = node.offsetTop + node.offsetHeight - this.chat.clientHeight;
    if (hiddenBelow > this.chat.scrollTop) this.chat.scrollTop = hiddenBelow;
  }

  private renderProposal(node: HTMLElement, message: ProposalMessage): void {
    const { edits } = message;
    const shared = getSharedStatus(edits);
    if (shared !== null && shared !== EditStatus.Proposed) node.classList.add(`is-${shared}`);
    const status = changeSetStatusText(edits);
    if (status !== undefined) {
      const badge = this.el('div', 'ola-result-status', status);
      badge.classList.add(`is-${shared === null ? 'partial' : shared}`);
      node.append(badge);
    }
    const [only] = edits;
    if (only !== undefined && edits.length === 1) {
      node.append(...this.renderEditBody(only));
      return;
    }
    for (const group of groupEditsByPath(edits)) node.append(this.renderFileEdits(message, group));
  }

  private renderFileEdits(message: ProposalMessage, group: FileEdits): HTMLElement {
    const section = this.el('div', 'ola-change-file');
    const head = this.el('div', 'ola-change-file-head');
    head.append(this.el('span', 'ola-change-path', group.path));
    const isOpen = group.indexes.some(
      (index) => message.edits[index]?.status === EditStatus.Proposed,
    );
    if (isOpen) {
      const show = this.actionButton('ola-preview-file', VIEW_TEXT.showFile, () =>
        this.events.previewFile(message.id, group.path),
      );
      show.title = VIEW_TEXT.showFileHint;
      head.append(show);
    }
    section.append(head);
    for (const index of group.indexes) {
      const edit = message.edits[index];
      if (edit === undefined)
        throw new InvariantViolation(`the change has no edit ${String(index)}`);
      section.append(this.renderEdit(message.id, index, edit));
    }
    return section;
  }

  private renderEdit(proposalId: string, index: number, edit: ProposedEdit): HTMLElement {
    const row = this.el('div', `ola-edit is-${edit.status}`);
    const status = editStatusText(edit.status);
    if (status !== undefined) {
      const badge = this.el('div', 'ola-result-status', status);
      badge.classList.add(`is-${edit.status}`);
      row.append(badge);
    }
    row.append(...this.renderEditBody(edit));
    row.append(this.el('div', 'ola-result-meta', editLinesMeta(edit.command)));
    if (edit.status === EditStatus.Proposed) {
      const actions = this.el('div', 'ola-edit-actions');
      actions.append(
        this.actionButton('ola-btn ola-apply-edit', VIEW_TEXT.apply, () =>
          this.events.apply(proposalId, index),
        ),
        this.actionButton('ola-btn ola-reject-edit', VIEW_TEXT.reject, () =>
          this.events.reject(proposalId, index),
        ),
      );
      row.append(actions);
    }
    return row;
  }

  private renderEditBody({ command }: ProposedEdit): HTMLElement[] {
    const parts: HTMLElement[] = [];
    if (command.reason !== undefined) {
      parts.push(this.el('div', 'ola-result-reason', command.reason));
    }
    switch (command.operation) {
      case DocumentOperation.InsertBefore:
      case DocumentOperation.InsertAfter:
      case DocumentOperation.Replace:
        parts.push(this.el('div', 'ola-result-body', command.content));
        break;
      case DocumentOperation.Delete:
        break;
    }
    return parts;
  }

  private renderCardActions(message: ProposalMessage): HTMLElement | null {
    if (canUndoEdits(message.edits)) {
      const actions = this.el('div', 'ola-result-actions');
      const undo = this.actionButton('ola-btn ola-undo', VIEW_TEXT.undo, () =>
        this.events.undo(message.id),
      );
      undo.title = VIEW_TEXT.undoHint;
      actions.append(undo);
      return actions;
    }
    if (findPendingEdits(message.edits).length === 0) return null;
    const isSingle = message.edits.length === 1;
    const actions = this.el('div', 'ola-result-actions');
    actions.append(
      this.actionButton('ola-btn ola-apply', isSingle ? VIEW_TEXT.apply : VIEW_TEXT.applyAll, () =>
        this.events.apply(message.id, null),
      ),
      this.actionButton(
        'ola-btn ola-reject',
        isSingle ? VIEW_TEXT.reject : VIEW_TEXT.rejectAll,
        () => this.events.reject(message.id, null),
      ),
    );
    return actions;
  }

  private actionButton(
    className: string,
    text: string,
    onClick: () => Promise<void>,
  ): HTMLButtonElement {
    const button = this.el('button', className, text);
    button.type = 'button';
    button.disabled = this.busy;
    button.addEventListener('click', () => {
      void onClick();
    });
    return button;
  }

  private renderSession(session: SessionSummary, currentId: string | null): HTMLElement {
    const row = this.el('li', 'ola-session');
    const isCurrent = session.id === currentId;
    const summary = isCurrent ? this.el('div', 'ola-session-open') : this.openButton(session.id);
    summary.append(
      this.el('span', 'ola-session-title', session.title),
      this.el('span', 'ola-session-meta', sessionDetails(session)),
    );
    if (isCurrent) {
      row.classList.add('is-current');
      summary.append(this.el('span', 'ola-session-badge', VIEW_TEXT.currentSession));
    }
    row.append(summary, this.renderSessionActions(session.id, true));
    return row;
  }

  private renderImport(path: string): HTMLElement {
    const row = this.el('li', 'ola-session ola-import-row');
    const summary = this.el('div', 'ola-session-open');
    summary.append(this.el('span', 'ola-session-title', exportFileName(path)));
    summary.title = path;
    const actions = this.el('div', 'ola-session-actions');
    const importButton = this.sessionButton('ola-import', VIEW_TEXT.importSession);
    importButton.title = VIEW_TEXT.importSessionHint;
    importButton.addEventListener('click', () => {
      void this.events.importSession(path);
    });
    actions.append(importButton);
    row.append(summary, actions);
    return row;
  }

  private openButton(id: string): HTMLButtonElement {
    const open = this.sessionButton('ola-session-open');
    open.title = VIEW_TEXT.openSessionHint;
    open.addEventListener('click', () => {
      void this.events.openSession(id);
    });
    return open;
  }

  private renderUnreadableSession(id: string): HTMLElement {
    const row = this.el('li', 'ola-session is-unreadable');
    const summary = this.el('div', 'ola-session-open');
    summary.append(this.el('span', 'ola-session-title', VIEW_TEXT.unreadableSession));
    row.append(summary, this.renderSessionActions(id, false));
    return row;
  }

  private renderSessionActions(id: string, exportable: boolean): HTMLElement {
    const actions = this.el('div', 'ola-session-actions');
    this.showSessionActions(actions, id, exportable);
    return actions;
  }

  private showSessionActions(actions: HTMLElement, id: string, exportable: boolean): void {
    const remove = this.sessionButton('ola-session-delete', VIEW_TEXT.deleteSession);
    remove.title = VIEW_TEXT.deleteSessionHint;
    remove.addEventListener('click', () => {
      this.showDeleteConfirmation(actions, id, exportable);
    });
    if (!exportable) {
      actions.replaceChildren(remove);
      return;
    }
    const exportButton = this.sessionButton('ola-session-export', VIEW_TEXT.exportSession);
    exportButton.title = VIEW_TEXT.exportSessionHint;
    exportButton.addEventListener('click', () => {
      void this.events.exportSession(id);
    });
    actions.replaceChildren(exportButton, remove);
  }

  private showDeleteConfirmation(actions: HTMLElement, id: string, exportable: boolean): void {
    const confirm = this.sessionButton('ola-session-confirm-delete', VIEW_TEXT.deleteSession);
    confirm.addEventListener('click', () => {
      void this.events.deleteSession(id);
    });
    const cancel = this.sessionButton('ola-session-cancel-delete', VIEW_TEXT.cancelDeleteSession);
    cancel.addEventListener('click', () => {
      this.showSessionActions(actions, id, exportable);
    });
    actions.replaceChildren(
      this.el('span', 'ola-session-question', VIEW_TEXT.confirmDeleteSession),
      confirm,
      cancel,
    );
  }

  private sessionButton(className: string, text?: string): HTMLButtonElement {
    const button = this.el('button', `ola-session-btn ${className}`, text);
    button.type = 'button';
    button.disabled = this.busy;
    return button;
  }

  private setSessionButtonsBusy(): void {
    for (const button of this.sessionList.querySelectorAll('button')) button.disabled = this.busy;
  }

  private showWelcome(): void {
    const node = this.el('div', 'ola-msg ola-welcome');
    node.append(
      this.el('div', 'ola-welcome-title', VIEW_TEXT.welcomeTitle),
      this.el('div', 'ola-welcome-copy', VIEW_TEXT.welcomeCopy),
    );
    this.append(node);
  }

  private append(node: HTMLElement): void {
    this.chat.insertBefore(node, this.typing);
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    this.chat.scrollTop = this.chat.scrollHeight;
  }

  private injectStyles(): void {
    if (this.document.getElementById(STYLE_ID)) return;
    const style = this.el('style');
    style.id = STYLE_ID;
    style.textContent = css;
    this.document.head.appendChild(style);
  }

  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = this.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
}

function windowOf(document: Document): Window {
  const window = document.defaultView;
  if (window === null) throw new InvariantViolation('the assistant needs a document with a window');
  return window;
}
