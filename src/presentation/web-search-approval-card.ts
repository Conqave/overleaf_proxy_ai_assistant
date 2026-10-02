import {
  AutoApprovalScope,
  WebSearchDecision,
  type PendingWebSearch,
} from '../application/web-search-approval';
import type { DomBuilder } from './dom-builder';
import { AUTO_APPROVAL_TEXT, VIEW_TEXT } from './message-format';

interface AutoApprovalOption {
  readonly input: HTMLInputElement;
  readonly label: HTMLElement;
  readonly decision: WebSearchDecision;
}

const AUTO_APPROVAL_DECISION: Record<AutoApprovalScope, WebSearchDecision> = {
  [AutoApprovalScope.Request]: WebSearchDecision.ApproveForRequest,
  [AutoApprovalScope.Session]: WebSearchDecision.ApproveForSession,
};

export class WebSearchApprovalCard {
  constructor(
    private readonly dom: DomBuilder,
    private readonly decide: (id: string, decision: WebSearchDecision) => Promise<void>,
  ) {}

  render({ id, query, autoApprovalScopes }: PendingWebSearch): HTMLElement {
    const node = this.dom.el('div', 'ola-msg ola-ai ola-approval');
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
      void this.decide(id, decision);
    };
    const approve = this.dom.button('ola-btn ola-approve-search', VIEW_TEXT.approve);
    approve.addEventListener('click', () => {
      decide(chosen());
    });
    const deny = this.dom.button('ola-btn ola-deny-search', VIEW_TEXT.deny);
    deny.addEventListener('click', () => {
      decide(WebSearchDecision.Deny);
    });
    const actions = this.dom.el('div', 'ola-result-actions');
    actions.append(approve, deny);
    node.append(
      this.dom.el('div', 'ola-result-title', VIEW_TEXT.approvalTitle),
      this.dom.el('div', 'ola-result-body ola-approval-query', query),
      this.dom.el('div', 'ola-result-meta', VIEW_TEXT.approvalNote),
      ...options.map(({ label }) => label),
      ...(options.length
        ? [this.dom.el('div', 'ola-result-meta', VIEW_TEXT.autoApprovalNote)]
        : []),
      actions,
    );
    return node;
  }

  private autoApprovalOption(scope: AutoApprovalScope): AutoApprovalOption {
    const input = this.dom.el('input', `ola-approval-${scope}`);
    input.type = 'checkbox';
    const label = this.dom.el('label', 'ola-approval-option');
    label.append(input, this.dom.el('span', undefined, AUTO_APPROVAL_TEXT[scope]));
    return { input, label, decision: AUTO_APPROVAL_DECISION[scope] };
  }
}
