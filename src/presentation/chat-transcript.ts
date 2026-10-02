import type { PendingWebSearch } from '../application/web-search-approval';
import {
  AssistantMessageKind,
  type ChatMessage,
  type ConversationMessage,
} from '../domain/conversation';
import { InvariantViolation } from '../domain/errors';
import type { DomBuilder } from './dom-builder';
import { VIEW_TEXT, type NoticeTone } from './message-format';
import { isShownMessage, type MessageRenderer, type ShownMessage } from './message-renderer';
import type { WebSearchApprovalCard } from './web-search-approval-card';

export class ChatTranscript {
  readonly element: HTMLElement;
  private readonly status: HTMLElement;
  private readonly typing: HTMLElement;
  private readonly messageNodes = new Map<string, HTMLElement>();
  private readonly proposalCards = new Map<string, HTMLElement>();
  private readonly approvalCards = new Map<string, HTMLElement>();
  private busy = false;

  constructor(
    private readonly dom: DomBuilder,
    private readonly renderer: MessageRenderer,
    private readonly approvalCard: WebSearchApprovalCard,
  ) {
    this.element = dom.el('div', 'ola-chat');
    this.status = dom.el('div', 'ola-status is-empty');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    const dots = dom.el('span', 'ola-typing-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(dom.el('span'), dom.el('span'), dom.el('span'));
    this.typing = dom.el('div', 'ola-typing');
    this.typing.hidden = true;
    this.typing.append(dots, this.status);
    this.element.append(this.typing);
    this.element.addEventListener(
      'toggle',
      (event) => {
        const fold = this.findShownNode(event.target);
        if (fold?.hasAttribute('open')) this.revealBottomOf(fold);
      },
      true,
    );
  }

  showConversation(messages: readonly ConversationMessage[]): void {
    this.element.replaceChildren(this.typing);
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
    this.removeWelcome();
    const node = this.render(message);
    this.messageNodes.set(message.id, node);
    this.append(node);
  }

  updateMessage(message: ChatMessage): void {
    const shown = this.messageNodes.get(message.id);
    if (shown === undefined)
      throw new InvariantViolation(`the chat shows no message ${message.id}`);
    this.proposalCards.delete(message.id);
    const node = this.render(message);
    shown.replaceWith(node);
    this.messageNodes.set(message.id, node);
  }

  showWebSearchApproval(search: PendingWebSearch): void {
    const node = this.approvalCard.render(search);
    this.removeWelcome();
    this.approvalCards.set(search.id, node);
    this.append(node);
  }

  removeWebSearchApproval(id: string): void {
    this.approvalCards.get(id)?.remove();
    this.approvalCards.delete(id);
  }

  showNotice(text: string, tone: NoticeTone): void {
    this.append(this.renderer.renderNotice({ text, tone }));
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.typing.hidden = !busy;
    if (busy) this.scrollToBottom();
    for (const card of this.proposalCards.values()) {
      for (const action of card.querySelectorAll('button')) action.disabled = busy;
    }
  }

  setStatus(text: string): void {
    this.status.textContent = text;
    this.status.classList.toggle('is-empty', !text);
    if (this.busy) this.scrollToBottom();
  }

  private revealBottomOf(node: HTMLElement): void {
    const hiddenBelow = node.offsetTop + node.offsetHeight - this.element.clientHeight;
    if (hiddenBelow > this.element.scrollTop) this.element.scrollTop = hiddenBelow;
  }

  private findShownNode(target: EventTarget | null): HTMLElement | undefined {
    return [...this.messageNodes.values()].find((node) => node === target);
  }

  private render(message: ShownMessage): HTMLElement {
    const node = this.renderer.render(message, this.busy);
    if (message.role === 'assistant' && message.kind === AssistantMessageKind.Proposal) {
      this.proposalCards.set(message.id, node);
    }
    return node;
  }

  private showWelcome(): void {
    const node = this.dom.el('div', 'ola-msg ola-welcome');
    node.append(
      this.dom.el('div', 'ola-welcome-title', VIEW_TEXT.welcomeTitle),
      this.dom.el('div', 'ola-welcome-copy', VIEW_TEXT.welcomeCopy),
    );
    this.append(node);
  }

  private removeWelcome(): void {
    this.element.querySelector('.ola-welcome')?.remove();
  }

  private append(node: HTMLElement): void {
    this.element.insertBefore(node, this.typing);
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    this.element.scrollTop = this.element.scrollHeight;
  }
}
