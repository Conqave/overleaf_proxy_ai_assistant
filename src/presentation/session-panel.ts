import type { SessionList } from '../application/conversation-session';
import type { SessionSummary } from '../domain/session';
import type { DomBuilder } from './dom-builder';
import { exportFileName, sessionDetails, VIEW_TEXT } from './message-format';
import type { ViewEvents } from './view-events';

type SessionEvents = Pick<
  ViewEvents,
  'openSession' | 'deleteSession' | 'exportSession' | 'showImports' | 'importSession'
>;

export class SessionPanel {
  readonly element: HTMLElement;
  private busy = false;

  constructor(
    private readonly dom: DomBuilder,
    private readonly events: SessionEvents,
  ) {
    this.element = dom.el('div', 'ola-sessions');
  }

  get isOpen(): boolean {
    return this.element.classList.contains('is-open');
  }

  showSessions({ sessions, unreadableIds, currentId }: SessionList): void {
    this.element.textContent = '';
    const head = this.dom.el('div', 'ola-sessions-head');
    const importButton = this.button('ola-imports-toggle', VIEW_TEXT.showImports);
    importButton.title = VIEW_TEXT.showImportsHint;
    importButton.addEventListener('click', () => {
      void this.events.showImports();
    });
    head.append(this.dom.el('div', 'ola-sessions-title', VIEW_TEXT.sessionsTitle), importButton);
    this.element.append(head);
    if (sessions.length || unreadableIds.length) {
      const rows = this.dom.el('ul', 'ola-session-list');
      for (const session of sessions) rows.append(this.renderSession(session, currentId));
      for (const id of unreadableIds) rows.append(this.renderUnreadableSession(id));
      this.element.append(rows);
    } else {
      this.element.append(this.dom.el('div', 'ola-sessions-empty', VIEW_TEXT.noSessions));
    }
    this.element.classList.add('is-open');
  }

  showImports(paths: readonly string[]): void {
    this.element.querySelector('.ola-imports')?.remove();
    const section = this.dom.el('div', 'ola-imports');
    section.append(this.dom.el('div', 'ola-sessions-title', VIEW_TEXT.importsTitle));
    if (paths.length) {
      const rows = this.dom.el('ul', 'ola-session-list');
      for (const path of paths) rows.append(this.renderImport(path));
      section.append(rows);
    } else {
      section.append(this.dom.el('div', 'ola-sessions-empty', VIEW_TEXT.noImports));
    }
    section.append(this.dom.el('div', 'ola-sessions-empty', VIEW_TEXT.importsReloadHint));
    this.element.querySelector('.ola-sessions-head')?.after(section);
  }

  close(): void {
    this.element.classList.remove('is-open');
    this.element.textContent = '';
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    for (const button of this.element.querySelectorAll('button')) button.disabled = busy;
  }

  private renderSession(session: SessionSummary, currentId: string | null): HTMLElement {
    const row = this.dom.el('li', 'ola-session');
    const isCurrent = session.id === currentId;
    const summary = isCurrent
      ? this.dom.el('div', 'ola-session-open')
      : this.openButton(session.id);
    summary.append(
      this.dom.el('span', 'ola-session-title', session.title),
      this.dom.el('span', 'ola-session-meta', sessionDetails(session)),
    );
    if (isCurrent) {
      row.classList.add('is-current');
      summary.append(this.dom.el('span', 'ola-session-badge', VIEW_TEXT.currentSession));
    }
    row.append(summary, this.renderSessionActions(session.id, true));
    return row;
  }

  private renderImport(path: string): HTMLElement {
    const row = this.dom.el('li', 'ola-session ola-import-row');
    const summary = this.dom.el('div', 'ola-session-open');
    summary.append(this.dom.el('span', 'ola-session-title', exportFileName(path)));
    summary.title = path;
    const actions = this.dom.el('div', 'ola-session-actions');
    const importButton = this.button('ola-import', VIEW_TEXT.importSession);
    importButton.title = VIEW_TEXT.importSessionHint;
    importButton.addEventListener('click', () => {
      void this.events.importSession(path);
    });
    actions.append(importButton);
    row.append(summary, actions);
    return row;
  }

  private openButton(id: string): HTMLButtonElement {
    const open = this.button('ola-session-open');
    open.title = VIEW_TEXT.openSessionHint;
    open.addEventListener('click', () => {
      void this.events.openSession(id);
    });
    return open;
  }

  private renderUnreadableSession(id: string): HTMLElement {
    const row = this.dom.el('li', 'ola-session is-unreadable');
    const summary = this.dom.el('div', 'ola-session-open');
    summary.append(this.dom.el('span', 'ola-session-title', VIEW_TEXT.unreadableSession));
    row.append(summary, this.renderSessionActions(id, false));
    return row;
  }

  private renderSessionActions(id: string, exportable: boolean): HTMLElement {
    const actions = this.dom.el('div', 'ola-session-actions');
    this.showSessionActions(actions, id, exportable);
    return actions;
  }

  private showSessionActions(actions: HTMLElement, id: string, exportable: boolean): void {
    const remove = this.button('ola-session-delete', VIEW_TEXT.deleteSession);
    remove.title = VIEW_TEXT.deleteSessionHint;
    remove.addEventListener('click', () => {
      this.showDeleteConfirmation(actions, id, exportable);
    });
    if (!exportable) {
      actions.replaceChildren(remove);
      return;
    }
    const exportButton = this.button('ola-session-export', VIEW_TEXT.exportSession);
    exportButton.title = VIEW_TEXT.exportSessionHint;
    exportButton.addEventListener('click', () => {
      void this.events.exportSession(id);
    });
    actions.replaceChildren(exportButton, remove);
  }

  private showDeleteConfirmation(actions: HTMLElement, id: string, exportable: boolean): void {
    const confirm = this.button('ola-session-confirm-delete', VIEW_TEXT.deleteSession);
    confirm.addEventListener('click', () => {
      void this.events.deleteSession(id);
    });
    const cancel = this.button('ola-session-cancel-delete', VIEW_TEXT.cancelDeleteSession);
    cancel.addEventListener('click', () => {
      this.showSessionActions(actions, id, exportable);
    });
    actions.replaceChildren(
      this.dom.el('span', 'ola-session-question', VIEW_TEXT.confirmDeleteSession),
      confirm,
      cancel,
    );
  }

  private button(className: string, text?: string): HTMLButtonElement {
    const button = this.dom.button(`ola-session-btn ${className}`, text);
    button.disabled = this.busy;
    return button;
  }
}
