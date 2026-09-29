import type { Extension, Range, Text } from '@codemirror/state';
import type { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { DocumentOperation, type DocumentCommand } from '../../domain/document-command';
import type { CodeMirrorApi } from './codemirror-api';
import { getAffectedLines, type AffectedLines } from './document-change';

const PREVIEW_CLASS = {
  target: 'ola-preview-target',
  removed: 'ola-preview-removed',
  added: 'ola-preview-added',
} as const;

export interface ChangePreview {
  readonly extension: Extension;
  show(view: EditorView, command: DocumentCommand): void;
  clear(view: EditorView): void;
}

export function createChangePreview(cm: CodeMirrorApi): ChangePreview {
  class AddedLinesWidget extends cm.WidgetType {
    constructor(private readonly content: string) {
      super();
    }

    override eq(other: AddedLinesWidget): boolean {
      return other.content === this.content;
    }

    toDOM(view: EditorView): HTMLElement {
      const block = view.dom.ownerDocument.createElement('div');
      block.className = PREVIEW_CLASS.added;
      for (const text of this.content.split('\n')) {
        const row = view.dom.ownerDocument.createElement('div');
        row.textContent = text;
        block.appendChild(row);
      }
      return block;
    }
  }

  const setPreview = cm.StateEffect.define<DecorationSet>();

  const field = cm.StateField.define<DecorationSet>({
    create: () => cm.Decoration.none,
    update(decorations, transaction) {
      let next = decorations.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (effect.is(setPreview)) next = effect.value;
      }
      return next;
    },
    provide: (self) => cm.EditorView.decorations.from(self),
  });

  const theme = cm.EditorView.baseTheme({
    [`.${PREVIEW_CLASS.target}`]: { backgroundColor: 'rgba(46, 204, 113, 0.18)' },
    [`.${PREVIEW_CLASS.removed}`]: { textDecoration: 'line-through', opacity: '0.6' },
    [`.${PREVIEW_CLASS.added}`]: {
      backgroundColor: 'rgba(46, 204, 113, 0.1)',
      borderLeft: '3px solid rgba(46, 204, 113, 0.8)',
      paddingLeft: '6px',
      fontStyle: 'italic',
      whiteSpace: 'pre-wrap',
    },
  });

  function decorationsFor(
    doc: Text,
    { first, last }: AffectedLines,
    command: DocumentCommand,
  ): DecorationSet {
    const ranges: Range<Decoration>[] = [];
    if (
      command.operation === DocumentOperation.InsertBefore ||
      command.operation === DocumentOperation.InsertAfter
    ) {
      ranges.push(cm.Decoration.line({ class: PREVIEW_CLASS.target }).range(first.from));
    } else {
      const removed = cm.Decoration.line({
        class: `${PREVIEW_CLASS.target} ${PREVIEW_CLASS.removed}`,
      });
      for (let number = first.number; number <= last.number; number += 1) {
        ranges.push(removed.range(doc.line(number).from));
      }
    }
    if (command.operation !== DocumentOperation.Delete) {
      const before = command.operation === DocumentOperation.InsertBefore;
      const added = cm.Decoration.widget({
        widget: new AddedLinesWidget(command.content),
        block: true,
        side: before ? -1 : 1,
      });
      ranges.push(added.range(before ? first.from : last.to));
    }
    return cm.Decoration.set(ranges, true);
  }

  return {
    extension: [field, theme],
    show(view, command) {
      const { doc } = view.state;
      const affected = getAffectedLines(doc, command);
      view.dispatch({
        effects: [
          setPreview.of(decorationsFor(doc, affected, command)),
          cm.EditorView.scrollIntoView(affected.first.from, { y: 'center' }),
        ],
      });
    },
    clear(view) {
      view.dispatch({ effects: setPreview.of(cm.Decoration.none) });
    },
  };
}
