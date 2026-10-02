import type { DomBuilder } from './dom-builder';
import { VIEW_TEXT } from './message-format';

export class RequestInput {
  readonly element: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private busy = false;

  constructor(
    dom: DomBuilder,
    private readonly send: (text: string) => void,
    stop: () => void,
  ) {
    this.input = dom.el('textarea', 'ola-textarea');
    this.input.placeholder = VIEW_TEXT.inputPlaceholder;
    this.input.addEventListener('input', () => {
      this.showSendable();
    });
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
    this.stopButton = dom.button('ola-btn ola-stop', VIEW_TEXT.stop);
    this.stopButton.title = VIEW_TEXT.stopHint;
    this.stopButton.hidden = true;
    this.stopButton.addEventListener('click', () => {
      this.stopButton.disabled = true;
      stop();
    });
    this.element = dom.el('div', 'ola-body');
    this.element.append(label, this.sendButton, this.stopButton);
    this.showSendable();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.sendButton.hidden = busy;
    this.stopButton.hidden = !busy;
    this.stopButton.disabled = false;
    this.showSendable();
  }

  clear(): void {
    this.input.value = '';
    this.input.focus();
    this.showSendable();
  }

  private canSend(): boolean {
    return !this.busy && this.input.value.trim() !== '';
  }

  private showSendable(): void {
    this.sendButton.disabled = !this.canSend();
  }

  private submit(): void {
    if (!this.canSend()) return;
    this.send(this.input.value);
  }
}
