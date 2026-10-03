import { expect } from 'vitest';
import { TestFixtureError } from './test-errors';

export function itemAt<T>(items: readonly T[], index: number, what: string): T {
  const item = items.at(index);
  if (item === undefined) {
    throw new TestFixtureError(`there is no ${what} at index ${String(index)}`);
  }
  return item;
}

export function groupOf(match: RegExpMatchArray | null, group: number, what: string): string {
  const text = match?.[group];
  if (text === undefined) throw new TestFixtureError(`found no ${what}`);
  return text;
}

export function elementById(document: Document, id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new TestFixtureError(`the page has no #${id}`);
  return element;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function anInstanceOf(type: abstract new (...args: never[]) => unknown): unknown {
  return expect.any(type);
}

export function objectContaining(fields: Record<string, unknown>): unknown {
  return expect.objectContaining(fields);
}

export function textContaining(text: string): unknown {
  return expect.stringContaining(text);
}

export function textMatching(pattern: RegExp): unknown {
  return expect.stringMatching(pattern);
}

export function pointerEventOf(window: object): typeof PointerEvent {
  const pointerEvent: unknown = Reflect.get(window, 'PointerEvent');
  if (!isPointerEventClass(pointerEvent))
    throw new TestFixtureError('the page has no PointerEvent');
  return pointerEvent;
}

function isPointerEventClass(value: unknown): value is typeof PointerEvent {
  return typeof value === 'function' && value.name === 'PointerEvent';
}
