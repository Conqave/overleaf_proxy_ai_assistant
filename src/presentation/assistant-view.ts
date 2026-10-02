import type { SessionList } from '../application/conversation-session';
import type { PendingWebSearch } from '../application/web-search-approval';
import type { ContextPressure } from '../domain/context-usage';
import type { ChatMessage, ConversationMessage } from '../domain/conversation';
import { InvariantViolation } from '../domain/errors';
import type { PanelSizeStore } from '../ports/panel-size-store';
import css from './assistant.css?raw';
import { ChangeSetCard } from './change-set-card';
import { ChatTranscript } from './chat-transcript';
import { DomBuilder } from './dom-builder';
import { MarkdownRenderer } from './markdown-renderer';
import { MessageRenderer } from './message-renderer';
import { VIEW_TEXT, type NoticeTone } from './message-format';
import { PanelHeader } from './panel-header';
import { PanelResizer } from './panel-resizer';
import { RequestInput } from './request-input';
import { SessionPanel } from './session-panel';
import type { ViewEvents } from './view-events';
import { WebSearchApprovalCard } from './web-search-approval-card';

const ROOT_ID = 'ola-root';
const STYLE_ID = 'ola-style';

export class AssistantView {
  private readonly root: HTMLElement;
  private readonly header: PanelHeader;
  private readonly sessions: SessionPanel;
  private readonly transcript: ChatTranscript;
  private readonly input: RequestInput;

  static isMounted(document: Document): boolean {
    return document.getElementById(ROOT_ID) !== null;
  }

  constructor(document: Document, events: ViewEvents, panelSize: PanelSizeStore) {
    const dom = new DomBuilder(document);
    injectStyles(dom);
    this.root = dom.el('div');
    this.root.id = ROOT_ID;

    const badge = dom.button('ola-badge', VIEW_TEXT.badge);
    badge.prepend(dom.el('span', 'ola-dot'));
    badge.addEventListener('click', () => this.root.classList.toggle('is-collapsed'));

    this.header = new PanelHeader(dom, {
      newConversation: () => void events.newConversation(),
      toggleSessions: () => {
        if (this.sessions.isOpen) this.sessions.close();
        else void events.showSessions();
      },
      compact: () => void events.compact(),
    });
    this.sessions = new SessionPanel(dom, events);
    const renderer = new MessageRenderer(
      dom,
      new MarkdownRenderer(document),
      new ChangeSetCard(dom, events),
    );
    this.transcript = new ChatTranscript(
      dom,
      renderer,
      new WebSearchApprovalCard(dom, (id, decision) => events.decideWebSearch(id, decision)),
    );
    this.input = new RequestInput(dom, (text) => void events.send(text));

    const panel = dom.el('section', 'ola-panel');
    const resizer = new PanelResizer(windowOf(document), panel, panelSize);
    panel.append(
      resizer.handle,
      this.header.element,
      this.sessions.element,
      this.transcript.element,
      this.input.element,
    );
    this.root.append(panel, badge);
    document.body.appendChild(this.root);
  }

  showConversation(messages: readonly ConversationMessage[]): void {
    this.transcript.showConversation(messages);
  }

  appendMessage(message: ConversationMessage): void {
    this.transcript.appendMessage(message);
  }

  updateMessage(message: ChatMessage): void {
    this.transcript.updateMessage(message);
  }

  showWebSearchApproval(search: PendingWebSearch): void {
    this.transcript.showWebSearchApproval(search);
  }

  removeWebSearchApproval(id: string): void {
    this.transcript.removeWebSearchApproval(id);
  }

  showSessionList(list: SessionList): void {
    this.sessions.showSessions(list);
  }

  showImportList(paths: readonly string[]): void {
    this.sessions.showImports(paths);
  }

  closeSessionList(): void {
    this.sessions.close();
  }

  showNotice(text: string, tone: NoticeTone): void {
    this.transcript.showNotice(text, tone);
  }

  setBusy(busy: boolean): void {
    this.root.classList.toggle('is-busy', busy);
    this.transcript.setBusy(busy);
    this.input.setBusy(busy);
    this.header.setBusy(busy);
    this.sessions.setBusy(busy);
  }

  setCompactable(compactable: boolean): void {
    this.header.setCompactable(compactable);
  }

  setStatus(text: string): void {
    this.transcript.setStatus(text);
  }

  setContextUsage(text: string, pressure: ContextPressure): void {
    this.header.setContextUsage(text, pressure);
  }

  clearInput(): void {
    this.input.clear();
  }
}

function injectStyles(dom: DomBuilder): void {
  if (dom.document.getElementById(STYLE_ID)) return;
  const style = dom.el('style');
  style.id = STYLE_ID;
  style.textContent = css;
  dom.document.head.appendChild(style);
}

function windowOf(document: Document): Window {
  const window = document.defaultView;
  if (window === null) throw new InvariantViolation('the assistant needs a document with a window');
  return window;
}
