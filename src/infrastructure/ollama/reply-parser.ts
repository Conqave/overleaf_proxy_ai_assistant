import {
  createToolCall,
  type AgentDecision,
  type AgentReply,
  type ToolCall,
} from '../../domain/agent-action';
import {
  createDocumentCommand,
  type DocumentCommand,
  type DocumentCommandInput,
} from '../../domain/document-command';
import {
  InvalidDocumentCommandError,
  InvalidProjectPathError,
  InvalidToolCallError,
  InvariantViolation,
  NamedError,
} from '../../domain/errors';
import { createProjectPath } from '../../domain/project-file';
import {
  AGENT_ACTIONS,
  AgentAction,
  AgentField,
  CONTENT,
  CONTENT_MARKER,
  createFieldPattern,
  EDIT_FIELDS,
  EditField,
  fieldLine,
  TEXT_MARKER,
} from './reply-format';

const ACTION_LINE = createFieldPattern([AgentField.Action]);

const TOOL_FIELDS: readonly string[] = [
  AgentField.Path,
  AgentField.Query,
  AgentField.StartLine,
  EditField.EndLine,
];

const AGENT_EDIT_FIELDS: readonly string[] = [AgentField.Path, ...EDIT_FIELDS];

export function parseAgentDecision(raw: string): AgentDecision {
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
      return { kind: 'tool', call: parseToolCall(action, rows) };
    case AgentAction.Answer:
      return { kind: 'reply', reply: { kind: 'answer', text: parseAnswerText(rows) } };
    case AgentAction.Question:
      return { kind: 'reply', reply: { kind: 'question', text: parseQuestion(rows) } };
    case AgentAction.Edit:
      return { kind: 'reply', reply: parseEditReply(rows) };
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

function parseToolCall(tool: ToolCall['tool'], rows: readonly string[]): ToolCall {
  const { fields, content } = parseHeaderReply(rows, TOOL_FIELDS);
  if (content !== undefined) {
    throw new InvalidAssistantResponse(`a ${tool} call has no content; send only its header lines`);
  }
  return createCall(tool, fields);
}

function createCall(tool: ToolCall['tool'], fields: HeaderReply['fields']): ToolCall {
  try {
    return createToolCall({
      tool,
      path: fields.get(AgentField.Path),
      query: fields.get(AgentField.Query),
      startLine: getOptionalLineNumber(fields, AgentField.StartLine),
      endLine: getOptionalLineNumber(fields, EditField.EndLine),
    });
  } catch (error) {
    if (!(error instanceof InvalidToolCallError)) throw error;
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
  const { fields, content } = parseHeaderReply(rows, [AgentField.Question]);
  if (content !== undefined) {
    throw new InvalidAssistantResponse(`a question has only the ${AgentField.Question} line`);
  }
  const question = getRequiredField(fields, AgentField.Question);
  if (question === '') throw new InvalidAssistantResponse(`${AgentField.Question} is empty`);
  return question;
}

function parseEditReply(rows: readonly string[]): AgentReply {
  const { fields, content } = parseHeaderReply(rows, AGENT_EDIT_FIELDS);
  const path = parseEditPath(getRequiredField(fields, AgentField.Path));
  const lineNumber = getLineNumber(fields, EditField.Line);
  const command = parseCommand({
    operation: getRequiredField(fields, EditField.Operation),
    target: { lineNumber, lineText: getRequiredField(fields, EditField.LineText) },
    ...(fields.has(EditField.EndLine)
      ? { lineCount: getLineNumber(fields, EditField.EndLine) - lineNumber + 1 }
      : {}),
    content,
    reason: getOptionalField(fields, EditField.Reason),
  });
  return { kind: 'edit', path, command };
}

function parseEditPath(value: string): string {
  try {
    return createProjectPath(value);
  } catch (error) {
    if (!(error instanceof InvalidProjectPathError)) throw error;
    throw new InvalidAssistantResponse(error.message);
  }
}

export class InvalidAssistantResponse extends NamedError {
  constructor(readonly problem: string) {
    super(`invalid assistant response: ${problem}`);
  }
}

interface HeaderReply {
  readonly fields: ReadonlyMap<string, string>;
  readonly content?: string;
}

const LINE_PATTERN = /\r?\n/;

function rejectJson(text: string, example: string): void {
  if (text.startsWith('{')) {
    throw new InvalidAssistantResponse(
      `the reply is JSON; write the plain header lines instead (${example}), without braces or quotes`,
    );
  }
}

function parseCommand(input: DocumentCommandInput): DocumentCommand {
  try {
    return createDocumentCommand(input);
  } catch (error) {
    if (!(error instanceof InvalidDocumentCommandError)) throw error;
    throw new InvalidAssistantResponse(error.message);
  }
}

function parseHeaderReply(rows: readonly string[], names: readonly string[]): HeaderReply {
  const pattern = createFieldPattern(names);
  const contentStart = rows.findIndex((row) => row.trimEnd() === CONTENT_MARKER);
  const fields = parseFields(
    contentStart === -1 ? rows : rows.slice(0, contentStart),
    pattern,
    names,
  );
  if (contentStart === -1) return { fields };
  const contentRows = rows.slice(contentStart + 1);
  while (contentRows.at(-1)?.trim() === '') contentRows.pop();
  if (contentRows.some((row) => row.trimStart().startsWith('```'))) {
    throw new InvalidAssistantResponse(`${CONTENT} must be raw LaTeX without markdown fences`);
  }
  const misplaced = contentRows.find((row) => pattern.test(row));
  if (misplaced !== undefined) {
    throw new InvalidAssistantResponse(
      `${JSON.stringify(misplaced)} comes after ${CONTENT_MARKER}; every header line goes before ${CONTENT_MARKER} and only the new LaTeX follows it`,
    );
  }
  if (contentRows.length === 0) return { fields };
  return { fields, content: contentRows.join('\n') };
}

function parseFields(
  headerRows: readonly string[],
  pattern: RegExp,
  names: readonly string[],
): Map<string, string> {
  const fields = new Map<string, string>();
  for (const row of headerRows) {
    if (row.trim() === '') continue;
    if (row.startsWith(CONTENT_MARKER)) {
      throw new InvalidAssistantResponse(
        `${JSON.stringify(row)} puts text on the ${CONTENT_MARKER} line; write ${CONTENT_MARKER} alone on its line and the new LaTeX on the lines below it`,
      );
    }
    const match = pattern.exec(row);
    if (!match) {
      throw new InvalidAssistantResponse(
        `unexpected line ${JSON.stringify(row)}; every line before ${CONTENT_MARKER} must be one of ${names.join(', ')} followed by ": "`,
      );
    }
    const [, name, value] = match;
    if (name === undefined || value === undefined) {
      throw new InvariantViolation('the field pattern always captures a field and its value');
    }
    if (fields.has(name)) throw new InvalidAssistantResponse(`${name} appears twice`);
    fields.set(name, name === EditField.LineText ? value : value.trim());
  }
  return fields;
}

function getOptionalField(fields: ReadonlyMap<string, string>, name: string): string | undefined {
  const value = fields.get(name);
  if (value === '') return undefined;
  return value;
}

function getRequiredField(fields: ReadonlyMap<string, string>, name: string): string {
  const value = fields.get(name);
  if (value === undefined) throw new InvalidAssistantResponse(`${name} is missing`);
  return value;
}

function getOptionalLineNumber(
  fields: ReadonlyMap<string, string>,
  name: string,
): number | undefined {
  return fields.has(name) ? getLineNumber(fields, name) : undefined;
}

function getLineNumber(fields: ReadonlyMap<string, string>, name: string): number {
  const value = getRequiredField(fields, name);
  if (!/^\d+$/.test(value))
    throw new InvalidAssistantResponse(`${name} must be a number, got "${value}"`);
  return Number(value);
}
