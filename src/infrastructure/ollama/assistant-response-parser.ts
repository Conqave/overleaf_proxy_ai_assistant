import { createAssistantPlan, type AssistantPlan } from '../../domain/assistant-plan';
import type { AssistantReply } from '../../domain/assistant-reply';
import type { DocumentSnapshot } from '../../domain/document';
import {
  createDocumentCommand,
  type DocumentCommand,
  type DocumentCommandInput,
} from '../../domain/document-command';
import {
  DocumentRangeError,
  DocumentTargetNotFoundError,
  InvalidAssistantPlanError,
  InvalidDocumentCommandError,
  InvariantViolation,
} from '../../domain/errors';
import { findLinesStartingWith, MIN_QUOTED_START } from '../../domain/document-target';
import { ResolvedEdit } from '../../domain/resolved-edit';

export class InvalidAssistantResponse extends Error {
  constructor(readonly problem: string) {
    super(`invalid assistant response: ${problem}`);
    this.name = 'InvalidAssistantResponse';
  }
}

type Json = Record<string, unknown>;

export function parsePlanResponse(raw: string): AssistantPlan {
  const data = decode(raw);
  allowOnly(data, ['intent', 'needs', 'reason']);
  try {
    return createAssistantPlan({ intent: data.intent, needs: data.needs, reason: data.reason });
  } catch (error) {
    if (error instanceof InvalidAssistantPlanError)
      throw new InvalidAssistantResponse(error.message);
    throw error;
  }
}

export function parseAnswerResponse(raw: string): string {
  const text = stripThinking(raw);
  if (text === '') throw new InvalidAssistantResponse('the reply is empty');
  return text;
}

export function parseEditResponse(raw: string, shown: DocumentSnapshot): AssistantReply {
  const text = stripThinking(raw);
  if (text === '') throw new InvalidAssistantResponse('the reply is empty');
  const { fields, content } = parseEditReply(text);
  if (fields.has('QUESTION')) {
    if (fields.size > 1 || content !== undefined) {
      throw new InvalidAssistantResponse('a QUESTION reply must contain nothing else');
    }
    const question = getRequiredField(fields, 'QUESTION');
    if (question === '') throw new InvalidAssistantResponse('QUESTION is empty');
    return { kind: 'question', text: question };
  }
  const operation = getRequiredField(fields, 'OPERATION');
  const lineNumber = getLineNumber(fields, 'LINE');
  const lastLine = fields.has('END_LINE') ? getLineNumber(fields, 'END_LINE') : lineNumber;
  if (lastLine < lineNumber) throw new InvalidAssistantResponse('END_LINE is before LINE');
  const rangeOperation = operation === 'replace' || operation === 'delete';
  if (!rangeOperation && fields.has('END_LINE')) {
    throw new InvalidAssistantResponse(`${operation} anchors on one line; leave out END_LINE`);
  }
  const command = parseCommand({
    operation,
    target: { lineNumber, lineText: getRequiredField(fields, 'LINE_TEXT') },
    lineCount: rangeOperation ? lastLine - lineNumber + 1 : undefined,
    content,
    reason: getOptionalField(fields, 'REASON'),
  });
  return {
    kind: 'edit',
    edit: resolveShown(shown, command),
    plan: getOptionalField(fields, 'PLAN'),
  };
}

function parseCommand(input: DocumentCommandInput): DocumentCommand {
  try {
    return createDocumentCommand(input);
  } catch (error) {
    if (!(error instanceof InvalidDocumentCommandError)) throw error;
    throw new InvalidAssistantResponse(error.message);
  }
}

export const EDIT_FIELDS = [
  'OPERATION',
  'LINE',
  'END_LINE',
  'LINE_TEXT',
  'REASON',
  'PLAN',
  'QUESTION',
] as const;
const EDIT_FIELD = new RegExp(`^(${EDIT_FIELDS.join('|')}):(?: (.*))?$`);

function parseEditReply(text: string): { fields: Map<string, string>; content?: string } {
  if (text.startsWith('{')) {
    throw new InvalidAssistantResponse(
      'the reply is JSON; write the plain header lines instead (OPERATION: <operation>, LINE: <number>), without braces or quotes',
    );
  }
  const rows = text.split(/\r?\n/);
  const contentStart = rows.findIndex((row) => row.trimEnd() === 'CONTENT:');
  const fields = parseFields(contentStart === -1 ? rows : rows.slice(0, contentStart));
  if (contentStart === -1) return { fields };
  const contentRows = rows.slice(contentStart + 1);
  while (contentRows.at(-1)?.trim() === '') contentRows.pop();
  if (contentRows.some((row) => row.trimStart().startsWith('```'))) {
    throw new InvalidAssistantResponse('CONTENT must be raw LaTeX without markdown fences');
  }
  if (contentRows.length === 0) return { fields };
  return { fields, content: contentRows.join('\n') };
}

function parseFields(headerRows: readonly string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const row of headerRows) {
    if (row.trim() === '') continue;
    const match = EDIT_FIELD.exec(row);
    if (!match) {
      throw new InvalidAssistantResponse(
        `unexpected line ${JSON.stringify(row)}; every line before CONTENT: must be one of ${EDIT_FIELDS.join(', ')} followed by ": "`,
      );
    }
    const [, name, value = ''] = match;
    if (name === undefined) throw new InvariantViolation('EDIT_FIELD always captures the name');
    if (fields.has(name)) throw new InvalidAssistantResponse(`${name} appears twice`);
    fields.set(name, name === 'LINE_TEXT' ? value : value.trim());
  }
  return fields;
}

function getOptionalField(fields: Map<string, string>, name: string): string {
  return fields.get(name) ?? '';
}

function getRequiredField(fields: Map<string, string>, name: string): string {
  const value = fields.get(name);
  if (value === undefined) throw new InvalidAssistantResponse(`${name} is missing`);
  return value;
}

function getLineNumber(fields: Map<string, string>, name: string): number {
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
        `${error.message}; END_LINE must be a line of the document`,
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
  const hint =
    quotedLine !== undefined && others.length === 0
      ? `; the text you quoted starts line ${String(quotedLine)}`
      : '';
  return `LINE_TEXT must be copied from the start of line ${String(lineNumber)} (at least ${String(MIN_QUOTED_START)} characters, or the whole line if shorter), which ${content}${hint}`;
}

function decode(raw: string): Json {
  const text = stripThinking(raw);
  if (text === '') throw new InvalidAssistantResponse('the reply is empty');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InvalidAssistantResponse('the reply is not valid JSON');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new InvalidAssistantResponse('the reply must be a JSON object');
  }
  return data as Json;
}

function stripThinking(raw: string): string {
  return raw.replace(/^\s*(?:<think>[\s\S]*?<\/think>\s*)+/i, '').trim();
}

function allowOnly(data: Json, keys: readonly string[]): void {
  const unexpected = Object.keys(data).filter((key) => !keys.includes(key));
  if (unexpected.length) {
    throw new InvalidAssistantResponse(`unexpected properties: ${unexpected.join(', ')}`);
  }
}
