import type { SessionList } from '../application/conversation-session';
import {
  AssistantMessageKind,
  ProposalStatus,
  type AssistantMessage,
  type ChatMessage,
  type CompactionSummaryMessage,
  type ConversationMessage,
  type ProposalMessage,
} from '../domain/conversation';
import { DocumentOperation } from '../domain/document-command';
import type { ContextPressure } from '../application/handle-assistant-request';
import type { SessionSummary } from '../domain/session';
import css from './assistant.css?raw';
import { InvariantViolation } from '../domain/errors';
import { MarkdownRenderer } from './markdown-renderer';
import {
  compactionFiles,
  compactionNotice,
  messageMeta,
  messageTitle,
  proposalStatusText,
  sessionDetails,
  VIEW_TEXT,
} from './message-format';

type ShownMessage = ChatMessage | CompactionSummaryMessage;

export interface ViewEvents {
  send(text: string): Promise<void>;
  apply(changeId: string): Promise<void>;
  reject(changeId: string): Promise<void>;
  newConversation(): Promise<void>;
  showSessions(): Promise<void>;
  openSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
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
  private readonly contextUsage: HTMLElement;
  private readonly markdown: MarkdownRenderer;
  private readonly messageNodes = new Map<string, HTMLElement>();
  private busy = false;
  private readonly actionNodes = new Map<string, HTMLElement>();

  static isMounted(document: Document): boolean {
    return document.getElementById(ROOT_ID) !== null;
  }

  constructor(
    private readonly document: Document,
    private readonly events: ViewEvents,
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
    head.append(
      this.el('span', 'ola-title', VIEW_TEXT.title),
      this.contextUsage,
      sessionsButton,
      newButton,
    );

    this.sessionList = this.el('div', 'ola-sessions');
    this.chat = this.el('div', 'ola-chat');

    this.status = this.el('div', 'ola-status is-empty');
    const labelRow = this.el('div', 'ola-label-row');
    labelRow.append(this.el('span', undefined, VIEW_TEXT.inputLabel), this.status);
    this.input = this.el('textarea', 'ola-textarea');
    this.input.placeholder = VIEW_TEXT.inputPlaceholder;
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.submit();
      }
    });
    const label = this.el('label', 'ola-label');
    label.append(labelRow, this.input);

    this.sendButton = this.el('button', 'ola-btn ola-send', VIEW_TEXT.send);
    this.sendButton.type = 'button';
    this.sendButton.addEventListener('click', () => {
      this.submit();
    });
    const body = this.el('div', 'ola-body');
    body.append(label, this.sendButton);
    const panel = this.el('section', 'ola-panel');
    panel.append(head, this.sessionList, this.chat, body);
    this.root.append(panel, badge);
    document.body.appendChild(this.root);
  }

  showConversation(messages: readonly ConversationMessage[]): void {
    this.chat.textContent = '';
    this.messageNodes.clear();
    this.actionNodes.clear();
    const chat = messages.filter((message): message is ShownMessage => message.role !== 'tool');
    if (!chat.length) {
      this.showWelcome();
      return;
    }
    for (const message of chat) this.appendMessage(message);
  }

  appendMessage(message: ShownMessage, changeId?: string): void {
    this.chat.querySelector('.ola-welcome')?.remove();
    const node = this.renderMessage(message, changeId);
    this.messageNodes.set(message.id, node);
    this.append(node);
  }

  updateMessage(message: ChatMessage): void {
    const shown = this.messageNodes.get(message.id);
    if (shown === undefined)
      throw new InvariantViolation(`the chat shows no message ${message.id}`);
    this.actionNodes.delete(message.id);
    const node = this.renderMessage(message);
    shown.replaceWith(node);
    this.messageNodes.set(message.id, node);
  }

  showSessionList({ sessions, unreadableIds, currentId }: SessionList): void {
    this.sessionList.textContent = '';
    this.sessionList.append(this.el('div', 'ola-sessions-title', VIEW_TEXT.sessionsTitle));
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

  closeSessionList(): void {
    this.sessionList.classList.remove('is-open');
    this.sessionList.textContent = '';
  }

  showNotice(text: string, tone: 'info' | 'error'): void {
    this.append(this.el('div', `ola-msg ${tone === 'error' ? 'ola-error' : 'ola-system'}`, text));
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.root.classList.toggle('is-busy', busy);
    this.sendButton.disabled = busy;
    for (const actions of this.actionNodes.values()) {
      for (const action of actions.querySelectorAll('button')) action.disabled = busy;
    }
    this.setSessionButtonsBusy();
  }

  setStatus(text: string): void {
    this.status.textContent = text;
    this.status.classList.toggle('is-empty', !text);
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

  private renderMessage(message: ShownMessage, changeId?: string): HTMLElement {
    switch (message.role) {
      case 'summary':
        return this.renderSummary(message);
      case 'user':
        return this.el('div', 'ola-msg ola-user', message.text);
      case 'system':
        return this.el('div', 'ola-msg ola-system', message.text);
      case 'assistant':
        return this.renderAssistant(message, changeId);
    }
  }

  private renderAssistant(message: AssistantMessage, changeId?: string): HTMLElement {
    const node = this.el('div', 'ola-msg ola-ai');
    node.append(this.el('div', 'ola-result-title', messageTitle(message)));
    switch (message.kind) {
      case AssistantMessageKind.Proposal:
        node.append(...this.renderProposal(message));
        node.classList.toggle(`is-${message.status}`, message.status !== ProposalStatus.Proposed);
        break;
      case AssistantMessageKind.Explanation:
      case AssistantMessageKind.Clarification:
        node.append(this.renderMarkdown('ola-result-body', message.text));
    }
    const meta = messageMeta(message);
    if (meta !== undefined) node.append(this.el('div', 'ola-result-meta', meta));
    if (changeId !== undefined) {
      const actions = this.el('div', 'ola-result-actions');
      const apply = this.el('button', 'ola-btn ola-apply', VIEW_TEXT.apply);
      const reject = this.el('button', 'ola-btn ola-reject', VIEW_TEXT.reject);
      apply.type = reject.type = 'button';
      apply.disabled = reject.disabled = this.busy;
      apply.addEventListener('click', () => {
        void this.events.apply(changeId);
      });
      reject.addEventListener('click', () => {
        void this.events.reject(changeId);
      });
      actions.append(apply, reject);
      node.append(actions);
      this.actionNodes.set(changeId, actions);
    }
    return node;
  }

  private renderMarkdown(className: string, text: string): HTMLElement {
    const node = this.el('div', `${className} ola-markdown`);
    node.append(this.markdown.render(text));
    return node;
  }

  private renderSummary(message: CompactionSummaryMessage): HTMLElement {
    const node = this.el('details', 'ola-msg ola-system ola-compaction');
    node.addEventListener('toggle', () => {
      if (node.open) this.revealBottomOf(node);
    });
    node.append(
      this.el('summary', 'ola-compaction-title', compactionNotice(message)),
      this.renderMarkdown('ola-compaction-body', message.text),
      this.el('div', 'ola-result-meta', compactionFiles(message)),
    );
    return node;
  }

  private revealBottomOf(node: HTMLElement): void {
    const hiddenBelow = node.offsetTop + node.offsetHeight - this.chat.clientHeight;
    if (hiddenBelow > this.chat.scrollTop) this.chat.scrollTop = hiddenBelow;
  }

  private renderProposal(message: ProposalMessage): HTMLElement[] {
    const { command } = message;
    const parts: HTMLElement[] = [];
    const status = proposalStatusText(message.status);
    if (status !== undefined) parts.push(this.el('div', 'ola-result-status', status));
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
    row.append(summary, this.renderDeleteActions(session.id));
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
    row.append(summary, this.renderDeleteActions(id));
    return row;
  }

  private renderDeleteActions(id: string): HTMLElement {
    const actions = this.el('div', 'ola-session-actions');
    this.showDeleteButton(actions, id);
    return actions;
  }

  private showDeleteButton(actions: HTMLElement, id: string): void {
    const remove = this.sessionButton('ola-session-delete', VIEW_TEXT.deleteSession);
    remove.title = VIEW_TEXT.deleteSessionHint;
    remove.addEventListener('click', () => {
      this.showDeleteConfirmation(actions, id);
    });
    actions.replaceChildren(remove);
  }

  private showDeleteConfirmation(actions: HTMLElement, id: string): void {
    const confirm = this.sessionButton('ola-session-confirm-delete', VIEW_TEXT.deleteSession);
    confirm.addEventListener('click', () => {
      void this.events.deleteSession(id);
    });
    const cancel = this.sessionButton('ola-session-cancel-delete', VIEW_TEXT.cancelDeleteSession);
    cancel.addEventListener('click', () => {
      this.showDeleteButton(actions, id);
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
    this.chat.appendChild(node);
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
