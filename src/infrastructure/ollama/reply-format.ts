import { AgentTool } from '../../domain/agent-action';

export const AgentField = {
  Action: 'ACTION',
  Path: 'PATH',
  Query: 'QUERY',
  StartLine: 'START_LINE',
  Question: 'QUESTION',
  Task: 'TASK',
  Files: 'FILES',
} as const;
export type AgentField = (typeof AgentField)[keyof typeof AgentField];

export const AgentAction = {
  ...AgentTool,
  Answer: 'answer',
  Question: 'question',
  Edit: 'edit',
} as const;
export type AgentAction = (typeof AgentAction)[keyof typeof AgentAction];

export const AGENT_ACTIONS: readonly AgentAction[] = Object.values(AgentAction);

export const EditField = {
  Operation: 'OPERATION',
  Line: 'LINE',
  EndLine: 'END_LINE',
  LineText: 'LINE_TEXT',
  Reason: 'REASON',
} as const;
export type EditField = (typeof EditField)[keyof typeof EditField];

export const EDIT_FIELDS: readonly EditField[] = Object.values(EditField);

const FIELD_MARK = ':';

export const FILE_SEPARATOR = ',';

export const CONTENT = 'CONTENT';

export const CONTENT_MARKER = `${CONTENT}${FIELD_MARK}`;

export const TEXT_MARKER = fieldName('TEXT');

export function createFieldPattern(names: readonly string[]): RegExp {
  return new RegExp(`^(${names.join('|')})${FIELD_MARK}(?: |$)(.*)$`);
}

function fieldName(field: string): string {
  return `${field}${FIELD_MARK}`;
}

export function fieldLine(field: string, value: string): string {
  return `${fieldName(field)} ${value}`;
}
