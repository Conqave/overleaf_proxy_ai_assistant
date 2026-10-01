import { AgentTool } from '../../domain/agent-action';
import { fieldName } from './edit-reply-format';

export const AgentField = {
  Action: 'ACTION',
  Path: 'PATH',
  Query: 'QUERY',
  Question: 'QUESTION',
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

export const TEXT = 'TEXT';

export const TEXT_MARKER = fieldName(TEXT);
