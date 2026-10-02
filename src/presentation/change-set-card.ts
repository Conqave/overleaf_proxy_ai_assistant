import {
  canUndoEdits,
  EditStatus,
  findPendingEdits,
  groupEditsByPath,
  type FileEdits,
  type ProposedEdit,
} from '../domain/change-set';
import type { ProposalMessage } from '../domain/conversation';
import { DocumentOperation } from '../domain/document-command';
import { InvariantViolation } from '../domain/errors';
import type { DomBuilder } from './dom-builder';
import {
  changeSetStatusText,
  editLinesMeta,
  editStatusText,
  getSharedStatus,
  messageMeta,
  messageTitle,
  VIEW_TEXT,
} from './message-format';
import type { ViewEvents } from './view-events';

type ChangeSetEvents = Pick<ViewEvents, 'apply' | 'reject' | 'previewFile' | 'undo'>;

export class ChangeSetCard {
  constructor(
    private readonly dom: DomBuilder,
    private readonly events: ChangeSetEvents,
  ) {}

  render(message: ProposalMessage, busy: boolean): HTMLElement {
    const node = this.dom.el('div', 'ola-msg ola-ai');
    node.append(this.dom.el('div', 'ola-result-title', messageTitle(message)));
    this.renderEdits(node, message, busy);
    const meta = messageMeta(message);
    if (meta !== undefined) node.append(this.dom.el('div', 'ola-result-meta', meta));
    const actions = this.renderActions(message, busy);
    if (actions !== null) node.append(actions);
    return node;
  }

  private renderEdits(node: HTMLElement, message: ProposalMessage, busy: boolean): void {
    const { edits } = message;
    const shared = getSharedStatus(edits);
    if (shared !== null && shared !== EditStatus.Proposed) node.classList.add(`is-${shared}`);
    const status = changeSetStatusText(edits);
    if (status !== undefined) {
      const badge = this.dom.el('div', 'ola-result-status', status);
      badge.classList.add(`is-${shared === null ? 'partial' : shared}`);
      node.append(badge);
    }
    const [only] = edits;
    if (only !== undefined && edits.length === 1) {
      node.append(...this.renderEditBody(only));
      return;
    }
    for (const group of groupEditsByPath(edits)) {
      node.append(this.renderFileEdits(message, group, busy));
    }
  }

  private renderFileEdits(message: ProposalMessage, group: FileEdits, busy: boolean): HTMLElement {
    const section = this.dom.el('div', 'ola-change-file');
    const head = this.dom.el('div', 'ola-change-file-head');
    head.append(this.dom.el('span', 'ola-change-path', group.path));
    const isOpen = group.indexes.some(
      (index) => message.edits[index]?.status === EditStatus.Proposed,
    );
    if (isOpen) {
      const show = this.actionButton('ola-preview-file', VIEW_TEXT.showFile, busy, () =>
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
      section.append(this.renderEdit(message.id, index, edit, busy));
    }
    return section;
  }

  private renderEdit(
    proposalId: string,
    index: number,
    edit: ProposedEdit,
    busy: boolean,
  ): HTMLElement {
    const row = this.dom.el('div', `ola-edit is-${edit.status}`);
    const status = editStatusText(edit.status);
    if (status !== undefined) {
      const badge = this.dom.el('div', 'ola-result-status', status);
      badge.classList.add(`is-${edit.status}`);
      row.append(badge);
    }
    row.append(...this.renderEditBody(edit));
    row.append(this.dom.el('div', 'ola-result-meta', editLinesMeta(edit.command)));
    if (edit.status === EditStatus.Proposed) {
      const actions = this.dom.el('div', 'ola-edit-actions');
      actions.append(
        this.actionButton('ola-btn ola-apply-edit', VIEW_TEXT.apply, busy, () =>
          this.events.apply(proposalId, index),
        ),
        this.actionButton('ola-btn ola-reject-edit', VIEW_TEXT.reject, busy, () =>
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
      parts.push(this.dom.el('div', 'ola-result-reason', command.reason));
    }
    switch (command.operation) {
      case DocumentOperation.InsertBefore:
      case DocumentOperation.InsertAfter:
      case DocumentOperation.Replace:
        parts.push(this.dom.el('div', 'ola-result-body', command.content));
        break;
      case DocumentOperation.Delete:
        break;
    }
    return parts;
  }

  private renderActions(message: ProposalMessage, busy: boolean): HTMLElement | null {
    if (canUndoEdits(message.edits)) {
      const actions = this.dom.el('div', 'ola-result-actions');
      const undo = this.actionButton('ola-btn ola-undo', VIEW_TEXT.undo, busy, () =>
        this.events.undo(message.id),
      );
      undo.title = VIEW_TEXT.undoHint;
      actions.append(undo);
      return actions;
    }
    if (findPendingEdits(message.edits).length === 0) return null;
    const [only] = message.edits;
    const isSingle = only !== undefined && message.edits.length === 1;
    const actions = this.dom.el('div', 'ola-result-actions');
    actions.append(
      this.actionButton(
        'ola-btn ola-apply',
        isSingle ? VIEW_TEXT.apply : VIEW_TEXT.applyAll,
        busy,
        () => this.events.apply(message.id, null),
      ),
      this.actionButton(
        'ola-btn ola-reject',
        isSingle ? VIEW_TEXT.reject : VIEW_TEXT.rejectAll,
        busy,
        () => this.events.reject(message.id, null),
      ),
    );
    if (isSingle) {
      const show = this.actionButton('ola-btn ola-preview-file', VIEW_TEXT.showFile, busy, () =>
        this.events.previewFile(message.id, only.path),
      );
      show.title = VIEW_TEXT.showFileHint;
      actions.append(show);
    }
    return actions;
  }

  private actionButton(
    className: string,
    text: string,
    busy: boolean,
    onClick: () => Promise<void>,
  ): HTMLButtonElement {
    const button = this.dom.button(className, text);
    button.disabled = busy;
    button.addEventListener('click', () => {
      void onClick();
    });
    return button;
  }
}
