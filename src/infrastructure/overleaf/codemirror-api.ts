import type { Extension, StateEffect, StateField } from '@codemirror/state';
import type { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { NamedError } from '../../domain/errors';

export const EXTENSIONS_EVENT = 'UNSTABLE_editor:extensions';

export interface CodeMirrorApi {
  readonly Decoration: typeof Decoration;
  readonly EditorView: typeof EditorView;
  readonly StateEffect: typeof StateEffect;
  readonly StateField: typeof StateField;
  readonly ViewPlugin: typeof ViewPlugin;
  readonly WidgetType: typeof WidgetType;
}

export interface ExtensionsEventDetail {
  readonly CodeMirror: CodeMirrorApi;
  readonly extensions: Extension[];
}

export class OverleafHookContractError extends NamedError {
  constructor(problem: string) {
    super(`Overleaf's ${EXTENSIONS_EVENT} event does not match the expected contract: ${problem}.`);
  }
}

export function getExtensionsEventDetail(event: Event): ExtensionsEventDetail {
  const detail: unknown = 'detail' in event ? event.detail : undefined;
  if (!isExtensionsEventDetail(detail)) {
    throw new OverleafHookContractError(
      'detail needs an extensions array and the CodeMirror classes Decoration, EditorView, StateEffect, StateField, ViewPlugin and WidgetType',
    );
  }
  return detail;
}

function isExtensionsEventDetail(value: unknown): value is ExtensionsEventDetail {
  if (typeof value !== 'object' || value === null) return false;
  if (!('extensions' in value) || !Array.isArray(value.extensions)) return false;
  if (!('CodeMirror' in value)) return false;
  const cm: unknown = value.CodeMirror;
  return (
    typeof cm === 'object' &&
    cm !== null &&
    'Decoration' in cm &&
    typeof cm.Decoration === 'function' &&
    'EditorView' in cm &&
    typeof cm.EditorView === 'function' &&
    'StateEffect' in cm &&
    typeof cm.StateEffect === 'function' &&
    'StateField' in cm &&
    typeof cm.StateField === 'function' &&
    'ViewPlugin' in cm &&
    typeof cm.ViewPlugin === 'function' &&
    'WidgetType' in cm &&
    typeof cm.WidgetType === 'function'
  );
}
