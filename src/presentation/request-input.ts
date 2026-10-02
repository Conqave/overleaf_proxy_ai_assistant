import type { DomBuilder } from './dom-builder';
import { VIEW_TEXT } from './message-format';

export class RequestInput {
  readonly element: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private busy = false;

  constructor(
    dom: DomBuilder,
    private readonly send: (text: string) => void,
  ) {
    this.input = dom.el('textarea', 'ola-textarea');
    this.input.placeholder = VIEW_TEXT.inputPlaceholder;
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.submit();
      }
    });
    const label = dom.el('label', 'ola-label');
    label.append(dom.el('span', undefined, VIEW_TEXT.inputLabel), this.input);
    this.sendButton = dom.button('ola-btn ola-send', VIEW_TEXT.send);
    this.sendButton.addEventListener('click', () => {
      this.submit();
    });
    this.element = dom.el('div', 'ola-body');
    this.element.append(label, this.sendButton);
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.sendButton.disabled = busy;
  }

  clear(): void {
    this.input.value = '';
    this.input.focus();
  }

  private submit(): void {
    if (this.busy) return;
    this.send(this.input.value);
  }
}
