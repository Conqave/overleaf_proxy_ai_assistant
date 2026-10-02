import type { ContextPressure } from '../domain/context-usage';
import type { DomBuilder } from './dom-builder';
import { VIEW_TEXT } from './message-format';

const PRESSURE_CLASS: Record<ContextPressure, string> = {
  low: 'is-low',
  elevated: 'is-elevated',
  high: 'is-high',
};

export interface HeaderEvents {
  newConversation(): void;
  toggleSessions(): void;
  compact(): void;
}

export class PanelHeader {
  readonly element: HTMLElement;
  private readonly contextUsage: HTMLElement;
  private readonly compactButton: HTMLButtonElement;
  private compactable = false;
  private busy = false;

  constructor(dom: DomBuilder, events: HeaderEvents) {
    this.element = dom.el('div', 'ola-head');
    const newButton = dom.button('ola-head-btn ola-new-chat', VIEW_TEXT.newChat);
    newButton.title = VIEW_TEXT.newChatHint;
    newButton.addEventListener('click', () => {
      events.newConversation();
    });
    const sessionsButton = dom.button('ola-head-btn ola-sessions-toggle', VIEW_TEXT.sessions);
    sessionsButton.title = VIEW_TEXT.sessionsHint;
    sessionsButton.addEventListener('click', () => {
      events.toggleSessions();
    });
    this.contextUsage = dom.el('span', 'ola-context');
    this.contextUsage.title = VIEW_TEXT.contextHint;
    this.compactButton = dom.button('ola-head-btn ola-compact', VIEW_TEXT.compact);
    this.compactButton.title = VIEW_TEXT.compactHint;
    this.compactButton.disabled = true;
    this.compactButton.addEventListener('click', () => {
      events.compact();
    });
    const titleRow = dom.el('div', 'ola-head-row');
    titleRow.append(dom.el('span', 'ola-title', VIEW_TEXT.title), this.contextUsage);
    const actions = dom.el('div', 'ola-head-actions');
    actions.append(this.compactButton, sessionsButton, newButton);
    this.element.append(titleRow, actions);
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.showCompactable();
  }

  setCompactable(compactable: boolean): void {
    this.compactable = compactable;
    this.showCompactable();
  }

  setContextUsage(text: string, pressure: ContextPressure): void {
    this.contextUsage.textContent = text;
    for (const [level, className] of Object.entries(PRESSURE_CLASS)) {
      this.contextUsage.classList.toggle(className, level === pressure);
    }
  }

  private showCompactable(): void {
    this.compactButton.disabled = this.busy || !this.compactable;
  }
}
