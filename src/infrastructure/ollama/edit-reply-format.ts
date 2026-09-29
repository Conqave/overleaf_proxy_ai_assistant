export const EditField = {
  Operation: 'OPERATION',
  Line: 'LINE',
  EndLine: 'END_LINE',
  LineText: 'LINE_TEXT',
  Reason: 'REASON',
  Plan: 'PLAN',
  Question: 'QUESTION',
} as const;
export type EditField = (typeof EditField)[keyof typeof EditField];

export const EDIT_FIELDS: readonly EditField[] = Object.values(EditField);

const FIELD_MARK = ':';

export const CONTENT = 'CONTENT';

export const CONTENT_MARKER = `${CONTENT}${FIELD_MARK}`;

export const FIELD_LINE = new RegExp(`^(${EDIT_FIELDS.join('|')})${FIELD_MARK}(?: |$)(.*)$`);

export function fieldName(field: EditField): string {
  return `${field}${FIELD_MARK}`;
}

export function fieldLine(field: EditField, value: string): string {
  return `${fieldName(field)} ${value}`;
}
