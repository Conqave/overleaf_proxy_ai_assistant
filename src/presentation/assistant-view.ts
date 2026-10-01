import {
  AssistantMessageKind,
  ProposalStatus,
  type AssistantMessage,
  type ConversationMessage,
  type ProposalMessage,
} from '../domain/conversation';
import { DocumentOperation } from '../domain/document-command';
import css from './assistant.css?raw';
import { InvariantViolation } from '../domain/errors';
import { MarkdownRenderer } from './markdown-renderer';
import { messageMeta, messageTitle, proposalStatusText, VIEW_TEXT } from './message-format';

export interface ViewEvents {
  send(text: string): Promise<void>;
  apply(changeId: string): Promise<void>;
  reject(changeId: string): Promise<void>;
  newConversation(): Promise<void>;
}

const ROOT_ID = 'ola-root';
const STYLE_ID = 'ola-style';

export class AssistantView {
  private readonly root: HTMLElement;
  private readonly chat: HTMLElement;
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
    const newButton = this.el('button', 'ola-new-chat', VIEW_TEXT.newChat);
    newButton.type = 'button';
    newButton.title = VIEW_TEXT.newChatHint;
    newButton.addEventListener('click', () => {
      void this.events.newConversation();
    });
    this.contextUsage = this.el('span', 'ola-context');
    this.contextUsage.title = VIEW_TEXT.contextHint;
    head.append(this.el('span', undefined, VIEW_TEXT.title), this.contextUsage, newButton);

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
    panel.append(head, this.chat, body);
    this.root.append(panel, badge);
    document.body.appendChild(this.root);
  }

  showConversation(messages: readonly ConversationMessage[]): void {
    this.chat.textContent = '';
    this.messageNodes.clear();
    this.actionNodes.clear();
    if (!messages.length) {
      this.showWelcome();
      return;
    }
    for (const message of messages) this.appendMessage(message);
  }

  appendMessage(message: ConversationMessage, changeId?: string): void {
    this.chat.querySelector('.ola-welcome')?.remove();
    const node = this.renderMessage(message, changeId);
    this.messageNodes.set(message.id, node);
    this.append(node);
  }

  updateMessage(message: ConversationMessage): void {
    const shown = this.messageNodes.get(message.id);
    if (shown === undefined)
      throw new InvariantViolation(`the chat shows no message ${message.id}`);
    this.actionNodes.delete(message.id);
    const node = this.renderMessage(message);
    shown.replaceWith(node);
    this.messageNodes.set(message.id, node);
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
  }

  setStatus(text: string): void {
    this.status.textContent = text;
    this.status.classList.toggle('is-empty', !text);
  }

  setContextUsage(text: string): void {
    this.contextUsage.textContent = text;
  }

  clearInput(): void {
    this.input.value = '';
    this.input.focus();
  }

  private submit(): void {
    if (this.busy) return;
    void this.events.send(this.input.value);
  }

  private renderMessage(message: ConversationMessage, changeId?: string): HTMLElement {
    switch (message.role) {
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
        node.append(this.renderMarkdown(message.text));
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

  private renderMarkdown(text: string): HTMLElement {
    const node = this.el('div', 'ola-result-body ola-markdown');
    node.append(this.markdown.render(text));
    return node;
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
