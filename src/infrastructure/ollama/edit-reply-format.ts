export const EditField = {
  Operation: 'OPERATION',
  Line: 'LINE',
  EndLine: 'END_LINE',
  LineText: 'LINE_TEXT',
  Reason: 'REASON',
  Plan: 'PLAN',
} as const;
export type EditField = (typeof EditField)[keyof typeof EditField];

export const EDIT_FIELDS: readonly EditField[] = Object.values(EditField);

const FIELD_MARK = ':';

export const CONTENT = 'CONTENT';

export const CONTENT_MARKER = `${CONTENT}${FIELD_MARK}`;

export function createFieldPattern(names: readonly string[]): RegExp {
  return new RegExp(`^(${names.join('|')})${FIELD_MARK}(?: |$)(.*)$`);
}

export function fieldName(field: string): string {
  return `${field}${FIELD_MARK}`;
}

export function fieldLine(field: string, value: string): string {
  return `${fieldName(field)} ${value}`;
}
