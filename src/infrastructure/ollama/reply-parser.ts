import {
  AgentTool,
  createToolCall,
  type AgentDecision,
  type AgentReply,
  type ToolCall,
} from '../../domain/agent-action';
import { AGENT_POLICY, type AgentPolicy } from '../../domain/agent-policy';
import type { EditRequest } from '../../domain/change-set';
import {
  createDocumentCommand,
  DocumentOperation,
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
  FILE_SEPARATOR,
  TEXT_MARKER,
} from './reply-format';

const ACTION_LINE = createFieldPattern([AgentField.Action]);

function getToolFields(tool: ToolCall['tool'], policy: AgentPolicy): readonly string[] {
  switch (tool) {
    case AgentAction.ReadFile:
      return [AgentField.Path, AgentField.StartLine, EditField.EndLine];
    case AgentAction.Search:
      return policy.scopedSearch ? [AgentField.Query, AgentField.Path] : [AgentField.Query];
    case AgentAction.Compile:
      return [];
    case AgentAction.Delegate:
      return [AgentField.Task, AgentField.Files];
    case AgentAction.WebSearch:
      return [AgentField.Query];
  }
}

const AGENT_EDIT_FIELDS: readonly string[] = [AgentField.Path, ...EDIT_FIELDS];

export function parseAgentDecision(raw: string, policy: AgentPolicy): AgentDecision {
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
    case AgentAction.Delegate:
    case AgentAction.WebSearch:
      return { kind: 'tool', call: parseToolCall(action, rows, policy) };
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

function parseToolCall(
  tool: ToolCall['tool'],
  rows: readonly string[],
  policy: AgentPolicy,
): ToolCall {
  const { fields, content } = parseHeaderReply(rows, tool, getToolFields(tool, policy));
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
      task: fields.get(AgentField.Task),
      files: splitFileList(getOptionalField(fields, AgentField.Files)),
    });
  } catch (error) {
    if (!(error instanceof InvalidToolCallError)) throw error;
    throw new InvalidAssistantResponse(error.message);
  }
}

function splitFileList(value: string | undefined): readonly string[] | undefined {
  return value?.split(FILE_SEPARATOR).map((path) => path.trim());
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
  const { fields, content } = parseHeaderReply(rows, AgentAction.Question, [AgentField.Question]);
  if (content !== undefined) {
    throw new InvalidAssistantResponse(`a question has only the ${AgentField.Question} line`);
  }
  const question = getRequiredField(fields, AgentField.Question);
  if (question === '') throw new InvalidAssistantResponse(`${AgentField.Question} is empty`);
  return question;
}

const PATH_LINE = createFieldPattern([AgentField.Path]);

function parseEditReply(rows: readonly string[]): AgentReply {
  const blocks = splitEditBlocks(rows);
  const { maxEditsPerChange } = AGENT_POLICY;
  if (blocks.length > maxEditsPerChange) {
    throw new InvalidAssistantResponse(
      `one ${AgentAction.Edit} reply carries at most ${String(maxEditsPerChange)} edit blocks, but this one has ${String(blocks.length)}; send at most ${String(maxEditsPerChange)} blocks: merge changes of neighbouring lines into one ${DocumentOperation.Replace} with ${EditField.Line} and ${EditField.EndLine}, or leave the rest for a later request`,
    );
  }
  if (blocks.length === 1) return { kind: 'edit', edits: blocks.map(parseEditBlock) };
  return {
    kind: 'edit',
    edits: blocks.map((block, index) => parseEditBlockOfMany(block, index, blocks.length)),
  };
}

function splitEditBlocks(rows: readonly string[]): readonly (readonly string[])[] {
  const blocks: string[][] = [[]];
  for (const row of rows) {
    const current = blocks.at(-1);
    if (current === undefined) throw new InvariantViolation('the edit blocks start with one block');
    const startsBlock = PATH_LINE.test(row) && current.some((line) => PATH_LINE.test(line));
    if (startsBlock) blocks.push([row]);
    else current.push(row);
  }
  return blocks;
}

function parseEditBlockOfMany(block: readonly string[], index: number, count: number): EditRequest {
  try {
    return parseEditBlock(block);
  } catch (error) {
    if (!(error instanceof InvalidAssistantResponse)) throw error;
    throw new InvalidAssistantResponse(
      `edit block ${String(index + 1)} of ${String(count)}: ${error.problem}`,
    );
  }
}

function parseEditBlock(rows: readonly string[]): EditRequest {
  const { fields, content } = parseHeaderReply(rows, AgentAction.Edit, AGENT_EDIT_FIELDS);
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
  return { path, command };
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

function parseHeaderReply(
  rows: readonly string[],
  action: AgentAction,
  names: readonly string[],
): HeaderReply {
  const pattern = createFieldPattern(names);
  const contentStart = rows.findIndex((row) => row.trimEnd() === CONTENT_MARKER);
  const fields = parseFields(contentStart === -1 ? rows : rows.slice(0, contentStart), {
    action,
    pattern,
    names,
  });
  if (contentStart === -1) return { fields };
  const contentRows = rows.slice(contentStart + 1);
  while (contentRows.at(-1)?.trim() === '') contentRows.pop();
  if (contentRows.some((row) => row.trimStart().startsWith('```'))) {
    throw new InvalidAssistantResponse(`${CONTENT} must be raw LaTeX without markdown fences`);
  }
  const misplaced = contentRows.find((row) => pattern.test(row));
  if (misplaced !== undefined) {
    throw new InvalidAssistantResponse(
      `${JSON.stringify(misplaced)} comes after ${CONTENT_MARKER}; every header line goes before ${CONTENT_MARKER} and only the new LaTeX follows it, and a further edit block starts with its own ${AgentField.Path} line`,
    );
  }
  if (contentRows.length === 0) return { fields };
  return { fields, content: contentRows.join('\n') };
}

interface HeaderRules {
  readonly action: AgentAction;
  readonly pattern: RegExp;
  readonly names: readonly string[];
}

function parseFields(headerRows: readonly string[], rules: HeaderRules): Map<string, string> {
  const fields = new Map<string, string>();
  const unexpectedFields = new Set<string>();
  const unexpectedLines: string[] = [];
  for (const row of headerRows) {
    if (row.trim() === '') continue;
    if (row.startsWith(CONTENT_MARKER)) {
      throw new InvalidAssistantResponse(
        `${JSON.stringify(row)} puts text on the ${CONTENT_MARKER} line; write ${CONTENT_MARKER} alone on its line and the new LaTeX on the lines below it`,
      );
    }
    const match = rules.pattern.exec(row);
    if (match) {
      const [, name, value] = match;
      if (name === undefined || value === undefined) {
        throw new InvariantViolation('the field pattern always captures a field and its value');
      }
      if (fields.has(name)) throw new InvalidAssistantResponse(repeatedFieldProblem(rules, name));
      fields.set(name, name === EditField.LineText ? value : value.trim());
      continue;
    }
    const otherField = ANY_FIELD.exec(row)?.[1];
    if (otherField === undefined) unexpectedLines.push(row);
    else unexpectedFields.add(otherField);
  }
  rejectUnexpected(rules, [...unexpectedFields], unexpectedLines);
  return fields;
}

const ANY_FIELD = /^([A-Z][A-Z_]*):(?: |$)/;

const LOOKUP_ACTIONS: readonly AgentAction[] = Object.values(AgentTool);

function repeatedFieldProblem({ action }: HeaderRules, name: string): string {
  if (!LOOKUP_ACTIONS.includes(action)) return `${name} appears twice`;
  return `${name} appears twice, but one reply is one ${action} with one ${name}; send only the first now and the next one in a later reply, after its result`;
}

function rejectUnexpected(
  { action, names }: HeaderRules,
  unexpectedFields: readonly string[],
  unexpectedLines: readonly string[],
): void {
  const problems: string[] = [];
  if (unexpectedFields.length) {
    const taken = names.length ? `only ${names.join(', ')}` : 'no other lines';
    problems.push(
      `${fieldLine(AgentField.Action, action)} takes ${taken}; remove ${unexpectedFields.join(', ')}`,
    );
  }
  if (unexpectedLines.length) {
    const quoted = unexpectedLines.map((row) => JSON.stringify(row)).join(', ');
    const subject = unexpectedLines.length === 1 ? 'line' : 'lines';
    const allowed = names.length
      ? `must be one of ${names.join(', ')} followed by ": "`
      : 'is not allowed';
    problems.push(
      `unexpected ${subject} ${quoted}; every line before ${CONTENT_MARKER} ${allowed}`,
    );
    if (unexpectedLines.some((row) => isListedField(row, names))) {
      problems.push(
        'write each field line at the very start of its line, without a list marker such as "- " in front',
      );
    }
  }
  if (problems.length) throw new InvalidAssistantResponse(problems.join('; '));
}

const LISTED_FIELD = /^\s*[-*•]\s*([A-Z][A-Z_]*):/;

function isListedField(row: string, names: readonly string[]): boolean {
  const name = LISTED_FIELD.exec(row)?.[1];
  return name !== undefined && names.includes(name);
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
