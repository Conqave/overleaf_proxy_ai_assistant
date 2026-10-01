import type { DocumentSnapshot } from '../../domain/document';
import {
  createDocumentCommand,
  type DocumentCommand,
  type DocumentCommandInput,
} from '../../domain/document-command';
import {
  DocumentRangeError,
  DocumentTargetNotFoundError,
  InvalidDocumentCommandError,
  InvariantViolation,
} from '../../domain/errors';
import { findLinesStartingWith, MIN_QUOTED_START } from '../../domain/document-target';
import { ResolvedEdit } from '../../domain/resolved-edit';
import { CONTENT, CONTENT_MARKER, EditField, createFieldPattern } from './edit-reply-format';

const NEARBY_LINES = 2;

export class InvalidAssistantResponse extends Error {
  constructor(readonly problem: string) {
    super(`invalid assistant response: ${problem}`);
    this.name = 'InvalidAssistantResponse';
  }
}

export interface HeaderReply {
  readonly fields: ReadonlyMap<string, string>;
  readonly content?: string;
}

export interface ParsedEdit {
  readonly edit: ResolvedEdit;
  readonly rationale?: string;
}

export const LINE_PATTERN = /\r?\n/;

export function rejectJson(text: string, example: string): void {
  if (text.startsWith('{')) {
    throw new InvalidAssistantResponse(
      `the reply is JSON; write the plain header lines instead (${example}), without braces or quotes`,
    );
  }
}

export function parseEdit(reply: HeaderReply, shown: DocumentSnapshot): ParsedEdit {
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
  const rationale = getOptionalField(fields, EditField.Plan);
  return {
    edit: resolveShown(shown, command),
    ...(rationale === undefined ? {} : { rationale }),
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

export function parseHeaderReply(rows: readonly string[], names: readonly string[]): HeaderReply {
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

export function getRequiredField(fields: ReadonlyMap<string, string>, name: string): string {
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
