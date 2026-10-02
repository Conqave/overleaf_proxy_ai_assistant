export class DomBuilder {
  constructor(readonly document: Document) {}

  el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = this.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  button(className: string, text?: string): HTMLButtonElement {
    const button = this.el('button', className, text);
    button.type = 'button';
    return button;
  }
}
