import { AgentTool } from '../domain/agent-action';
import type { DelegateRecord, WebSearchRecord } from '../domain/agent-transcript';
import {
  AssistantMessageKind,
  type ChatMessage,
  type CompactionSummaryMessage,
  type ConversationMessage,
  type NoticeMessage,
  type ReplyMessage,
  type ToolMessage,
  type UndoMessage,
} from '../domain/conversation';
import { DelegationOutcome } from '../domain/delegation';
import { WebSearchStatus } from '../domain/web-search';
import type { ChangeSetCard } from './change-set-card';
import type { DomBuilder } from './dom-builder';
import type { MarkdownRenderer } from './markdown-renderer';
import {
  COMPILE_FIX_NOTE,
  compactionFiles,
  compactionNotice,
  delegationMeta,
  delegationTitle,
  messageTitle,
  noticeText,
  undoNotice,
  undoRefusalNotice,
  webResultSource,
  webSearchMeta,
  webSearchTitle,
  type NoticeText,
} from './message-format';

interface ShownToolMessage extends ToolMessage {
  readonly record: DelegateRecord | WebSearchRecord;
}

export type ShownMessage =
  ChatMessage | CompactionSummaryMessage | UndoMessage | NoticeMessage | ShownToolMessage;

export function isShownMessage(message: ConversationMessage): message is ShownMessage {
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

export class MessageRenderer {
  constructor(
    private readonly dom: DomBuilder,
    private readonly markdown: MarkdownRenderer,
    private readonly changeSetCard: ChangeSetCard,
  ) {}

  render(message: ShownMessage, busy: boolean): HTMLElement {
    switch (message.role) {
      case 'summary':
        return this.renderSummary(message);
      case 'undo':
        return this.renderUndo(message);
      case 'notice':
        return this.renderNotice(noticeText(message.notice));
      case 'user':
        return this.dom.el('div', 'ola-msg ola-user', message.text);
      case 'system':
        return this.dom.el('div', 'ola-msg ola-system ola-system-request', COMPILE_FIX_NOTE);
      case 'assistant':
        return message.kind === AssistantMessageKind.Proposal
          ? this.changeSetCard.render(message, busy)
          : this.renderReply(message);
      case 'tool':
        return this.renderToolRecord(message.record);
    }
  }

  renderNotice({ text, tone }: NoticeText): HTMLElement {
    return this.dom.el('div', `ola-msg ${tone === 'error' ? 'ola-error' : 'ola-system'}`, text);
  }

  private renderReply(message: ReplyMessage): HTMLElement {
    const node = this.dom.el('div', 'ola-msg ola-ai');
    node.append(
      this.dom.el('div', 'ola-result-title', messageTitle(message)),
      this.renderMarkdown('ola-result-body', message.text),
    );
    return node;
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
    const summary = this.dom.el('summary', 'ola-fold-title ola-web-search-title', title);
    summary.title = title;
    node.append(summary);
    const { outcome } = record;
    switch (outcome.status) {
      case WebSearchStatus.Found: {
        const list = this.dom.el('ol', 'ola-fold-body ola-web-results');
        for (const result of outcome.results) {
          const link = this.dom.el('a', 'ola-web-link', result.title);
          link.href = result.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          const item = this.dom.el('li', 'ola-web-result');
          item.append(link, this.dom.el('div', 'ola-web-source', webResultSource(result)));
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
        node.append(this.dom.el('div', 'ola-fold-body', outcome.problem));
    }
    const meta = webSearchMeta(record);
    if (meta !== undefined) node.append(this.dom.el('div', 'ola-result-meta', meta));
    return node;
  }

  private renderMarkdown(className: string, text: string): HTMLElement {
    const node = this.dom.el('div', `${className} ola-markdown`);
    node.append(this.markdown.render(text));
    return node;
  }

  private renderUndo(message: UndoMessage): HTMLElement {
    const node = this.dom.el('div', 'ola-msg ola-system ola-undo-notice');
    node.append(this.dom.el('div', undefined, undoNotice(message)));
    for (const refusal of message.refused) {
      node.append(this.dom.el('div', 'ola-error', undoRefusalNotice(refusal)));
    }
    return node;
  }

  private renderSummary(message: CompactionSummaryMessage): HTMLElement {
    const node = this.fold('ola-compaction');
    node.append(
      this.dom.el('summary', 'ola-fold-title ola-compaction-title', compactionNotice(message)),
      this.renderMarkdown('ola-fold-body ola-compaction-body', message.text),
      this.dom.el('div', 'ola-result-meta', compactionFiles(message)),
    );
    return node;
  }

  private renderDelegation(record: DelegateRecord): HTMLElement {
    const node = this.fold('ola-delegation');
    const title = delegationTitle(record);
    const summary = this.dom.el('summary', 'ola-fold-title ola-delegation-title', title);
    summary.title = title;
    node.append(summary);
    const { report } = record;
    switch (report.outcome) {
      case DelegationOutcome.Finished:
        node.append(this.renderMarkdown('ola-fold-body ola-delegation-body', report.text));
        break;
      case DelegationOutcome.Failed:
        node.classList.add('is-failed');
        node.append(this.dom.el('div', 'ola-fold-body ola-delegation-body', report.problem));
    }
    node.append(this.dom.el('div', 'ola-result-meta', delegationMeta(record)));
    return node;
  }

  private fold(className: string): HTMLDetailsElement {
    return this.dom.el('details', `ola-msg ola-system ola-fold ${className}`);
  }
}
