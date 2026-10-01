import {
  createToolCall,
  type AgentDecision,
  type AgentReply,
  type ToolCall,
} from '../../domain/agent-action';
import { checkToolCall } from '../../domain/agent-policy';
import { getShownDocument } from '../../domain/agent-transcript';
import {
  InvalidToolCallError,
  InvariantViolation,
  NotATextFileError,
  ProjectFileNotFoundError,
  RepeatedToolCallError,
  ToolBudgetExhaustedError,
  UnreadFileEditError,
} from '../../domain/errors';
import type { DocumentSnapshot } from '../../domain/document';
import { findTextFile } from '../../domain/project-file';
import type { AgentStepRequest } from '../../ports/agent-port';
import { AGENT_ACTIONS, AgentAction, AgentField, TEXT_MARKER } from './agent-reply-format';
import {
  getQuestion,
  getRequiredField,
  InvalidAssistantResponse,
  LINE_PATTERN,
  parseEdit,
  parseHeaderReply,
  rejectJson,
  type HeaderReply,
} from './assistant-response-parser';
import { createFieldPattern, EDIT_COMMAND_FIELDS, EditField, fieldLine } from './edit-reply-format';

const ACTION_LINE = createFieldPattern([AgentField.Action]);

const TOOL_FIELDS: readonly string[] = [AgentField.Path, AgentField.Query];

const AGENT_EDIT_FIELDS: readonly string[] = [AgentField.Path, ...EDIT_COMMAND_FIELDS];

export function parseAgentDecision(raw: string, request: AgentStepRequest): AgentDecision {
  const text = raw.trim();
  if (text === '') {
    throw new InvalidAssistantResponse(
      'the reply text is empty; write the action as plain text lines in the reply, never as a function call',
    );
  }
  rejectJson(text, fieldLine(AgentField.Action, '<action>'));
  const [first, ...rows] = text.split(LINE_PATTERN);
  if (first === undefined) throw new InvariantViolation('a split string has a first part');
  const action = parseAction(first);
  switch (action) {
    case AgentAction.ReadFile:
    case AgentAction.Search:
    case AgentAction.Compile:
      return { kind: 'tool', call: parseToolCall(action, rows, request) };
    case AgentAction.Answer:
      return { kind: 'reply', reply: { kind: 'answer', text: parseAnswerText(rows) } };
    case AgentAction.Question:
      return { kind: 'reply', reply: { kind: 'question', text: parseQuestion(rows) } };
    case AgentAction.Edit:
      return { kind: 'reply', reply: parseEditReply(rows, request) };
  }
}

function parseAction(line: string): AgentAction {
  const match = ACTION_LINE.exec(line);
  if (match === null) {
    throw new InvalidAssistantResponse(
      `the first line must be ${fieldLine(AgentField.Action, '<action>')}, got ${JSON.stringify(line)}`,
    );
  }
  const value = match[2];
  if (value === undefined) throw new InvariantViolation('the field pattern captures a value');
  const action = AGENT_ACTIONS.find((candidate) => candidate === value.trim());
  if (action === undefined) {
    throw new InvalidAssistantResponse(
      `unknown action ${JSON.stringify(value.trim())}; use one of ${AGENT_ACTIONS.join(', ')}`,
    );
  }
  return action;
}

function parseToolCall(
  tool: ToolCall['tool'],
  rows: readonly string[],
  request: AgentStepRequest,
): ToolCall {
  const { fields, content } = parseHeaderReply(rows, TOOL_FIELDS);
  if (content !== undefined) {
    throw new InvalidAssistantResponse(`a ${tool} call has no content; send only its header lines`);
  }
  const call = createCall(tool, fields);
  if (call.tool === AgentAction.ReadFile) findProjectTextFile(request, call.path);
  checkBudget(request, call);
  return call;
}

function createCall(tool: ToolCall['tool'], fields: HeaderReply['fields']): ToolCall {
  try {
    return createToolCall({
      tool,
      path: fields.get(AgentField.Path),
      query: fields.get(AgentField.Query),
    });
  } catch (error) {
    if (!(error instanceof InvalidToolCallError)) throw error;
    throw new InvalidAssistantResponse(error.message);
  }
}

function findProjectTextFile(request: AgentStepRequest, path: string): void {
  try {
    findTextFile(request.workspace.files, path);
  } catch (error) {
    if (!(error instanceof ProjectFileNotFoundError || error instanceof NotATextFileError)) {
      throw error;
    }
    throw new InvalidAssistantResponse(
      `${error.message} ${AgentField.Path} must be a text file from the project file list`,
    );
  }
}

function checkBudget(request: AgentStepRequest, call: ToolCall): void {
  try {
    checkToolCall(request.transcript, call);
  } catch (error) {
    if (!(error instanceof ToolBudgetExhaustedError || error instanceof RepeatedToolCallError)) {
      throw error;
    }
    throw new InvalidAssistantResponse(error.message);
  }
}

function parseAnswerText(rows: readonly string[]): string {
  const start = rows.findIndex((row) => row.trim() !== '');
  const first = rows[start];
  if (first === undefined || !first.startsWith(TEXT_MARKER)) {
    throw new InvalidAssistantResponse(`an answer must continue with a ${TEXT_MARKER} line`);
  }
  const text = [first.slice(TEXT_MARKER.length), ...rows.slice(start + 1)].join('\n').trim();
  if (text === '') throw new InvalidAssistantResponse(`the text after ${TEXT_MARKER} is empty`);
  return text;
}

function parseQuestion(rows: readonly string[]): string {
  const reply = parseHeaderReply(rows, [EditField.Question]);
  if (reply.content !== undefined) {
    throw new InvalidAssistantResponse(`a question has only the ${EditField.Question} line`);
  }
  return getQuestion(reply.fields);
}

function parseEditReply(rows: readonly string[], request: AgentStepRequest): AgentReply {
  const reply = parseHeaderReply(rows, AGENT_EDIT_FIELDS);
  const path = getRequiredField(reply.fields, AgentField.Path);
  findProjectTextFile(request, path);
  const { edit, rationale } = parseEdit(reply, getShown(request, path));
  return {
    kind: 'edit',
    change: { path, edit },
    ...(rationale === undefined ? {} : { rationale }),
  };
}

function getShown(request: AgentStepRequest, path: string): DocumentSnapshot {
  try {
    return getShownDocument(request.workspace.openFile, request.transcript, path);
  } catch (error) {
    if (!(error instanceof UnreadFileEditError)) throw error;
    throw new InvalidAssistantResponse(error.message);
  }
}
