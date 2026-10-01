import {
  createToolCall,
  type AgentDecision,
  type AgentReply,
  type ToolCall,
} from '../../domain/agent-action';
import { checkToolCall } from '../../domain/agent-policy';
import { getShownDocument } from '../../domain/agent-transcript';
import type { DocumentSnapshot } from '../../domain/document';
import {
  createDocumentCommand,
  type DocumentCommand,
  type DocumentCommandInput,
} from '../../domain/document-command';
import { findLinesStartingWith, MIN_QUOTED_START } from '../../domain/document-target';
import {
  DocumentRangeError,
  DocumentTargetNotFoundError,
  InvalidDocumentCommandError,
  InvalidToolCallError,
  InvariantViolation,
  NamedError,
  NotATextFileError,
  ProjectFileNotFoundError,
  RepeatedToolCallError,
  ToolBudgetExhaustedError,
  UnreadFileEditError,
} from '../../domain/errors';
import { findTextFile } from '../../domain/project-file';
import { ResolvedEdit } from '../../domain/resolved-edit';
import type { AgentStepRequest } from '../../ports/agent-port';
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

const TOOL_FIELDS: readonly string[] = [AgentField.Path, AgentField.Query];

const AGENT_EDIT_FIELDS: readonly string[] = [AgentField.Path, ...EDIT_FIELDS];

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
  const { fields, content } = parseHeaderReply(rows, [AgentField.Question]);
  if (content !== undefined) {
    throw new InvalidAssistantResponse(`a question has only the ${AgentField.Question} line`);
  }
  const question = getRequiredField(fields, AgentField.Question);
  if (question === '') throw new InvalidAssistantResponse(`${AgentField.Question} is empty`);
  return question;
}

function parseEditReply(rows: readonly string[], request: AgentStepRequest): AgentReply {
  const reply = parseHeaderReply(rows, AGENT_EDIT_FIELDS);
  const path = getRequiredField(reply.fields, AgentField.Path);
  findProjectTextFile(request, path);
  const edit = parseEdit(reply, getShown(request, path));
  return { kind: 'edit', change: { path, edit } };
}

function getShown(request: AgentStepRequest, path: string): DocumentSnapshot {
  try {
    return getShownDocument(request.workspace.openFile, request.transcript, path);
  } catch (error) {
    if (!(error instanceof UnreadFileEditError)) throw error;
    throw new InvalidAssistantResponse(error.message);
  }
}

const NEARBY_LINES = 2;

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

function parseEdit(reply: HeaderReply, shown: DocumentSnapshot): ResolvedEdit {
  const { fields, content } = reply;
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
  return resolveShown(shown, command);
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

function getLineNumber(fields: ReadonlyMap<string, string>, name: string): number {
  const value = getRequiredField(fields, name);
  if (!/^\d+$/.test(value))
    throw new InvalidAssistantResponse(`${name} must be a number, got "${value}"`);
  return Number(value);
}

function resolveShown(shown: DocumentSnapshot, command: DocumentCommand): ResolvedEdit {
  try {
    return ResolvedEdit.resolve(shown, command);
  } catch (error) {
    if (error instanceof DocumentRangeError) {
      throw new InvalidAssistantResponse(
        `${error.message}; ${EditField.EndLine} must be a line of the document`,
      );
    }
    if (!(error instanceof DocumentTargetNotFoundError)) throw error;
    throw new InvalidAssistantResponse(describeTargetMismatch(shown, command));
  }
}

function describeTargetMismatch(shown: DocumentSnapshot, command: DocumentCommand): string {
  const { lineNumber, lineText } = command.target;
  const actual = shown.lines[lineNumber - 1];
  if (actual === undefined) {
    return `line ${String(lineNumber)} does not exist; the document has ${String(shown.lines.length)} lines`;
  }
  const content = actual.trim() === '' ? 'is an empty line' : `reads: ${actual}`;
  const [quotedLine, ...others] = findLinesStartingWith(shown, lineText);
  if (quotedLine !== undefined && others.length === 0) {
    return `${EditField.LineText} quotes line ${String(quotedLine)}, not line ${String(lineNumber)}, which ${content}; to target line ${String(quotedLine)} write ${EditField.Line}: ${String(quotedLine)}, to target line ${String(lineNumber)} copy its text into ${EditField.LineText}. The lines around line ${String(lineNumber)} are:\n${describeNearbyLines(shown, lineNumber)}`;
  }
  return `${EditField.LineText} must be copied from the start of line ${String(lineNumber)} (at least ${String(MIN_QUOTED_START)} characters, or the whole line if shorter), which ${content}`;
}

function describeNearbyLines(shown: DocumentSnapshot, lineNumber: number): string {
  const first = Math.max(1, lineNumber - NEARBY_LINES);
  return shown.lines
    .slice(first - 1, lineNumber + NEARBY_LINES)
    .map((text, index) => `${String(first + index)}: ${text}`)
    .join('\n');
}
