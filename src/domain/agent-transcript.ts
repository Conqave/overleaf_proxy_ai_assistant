import { AgentTool, type AgentDecision, type ToolCall } from './agent-action';
import { isSameDocument, type DocumentSnapshot } from './document';
import { DocumentOperation, type DocumentCommand } from './document-command';
import {
  InvalidToolRecordError,
  InvariantViolation,
  UnreadFileEditError,
  UnshownLinesEditError,
} from './errors';
import type { LineSpan } from './read-window';

export interface SearchMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly lineText: string;
}

export const DiagnosticLevel = {
  Error: 'error',
  Warning: 'warning',
  Typesetting: 'typesetting',
} as const;
export type DiagnosticLevel = (typeof DiagnosticLevel)[keyof typeof DiagnosticLevel];

const DIAGNOSTIC_LEVELS: readonly string[] = Object.values(DiagnosticLevel);

export function isDiagnosticLevel(value: unknown): value is DiagnosticLevel {
  return typeof value === 'string' && DIAGNOSTIC_LEVELS.includes(value);
}

export interface CompileDiagnostic {
  readonly level: DiagnosticLevel;
  readonly message: string;
  readonly path?: string;
  readonly lineNumber?: number;
}

export type ToolResult =
  | {
      readonly tool: typeof AgentTool.ReadFile;
      readonly path: string;
      readonly document: DocumentSnapshot;
      readonly shown: LineSpan;
    }
  | {
      readonly tool: typeof AgentTool.Search;
      readonly matches: readonly SearchMatch[];
      readonly truncated: boolean;
    }
  | { readonly tool: typeof AgentTool.Compile; readonly diagnostics: readonly CompileDiagnostic[] };

export interface ReadRecord {
  readonly tool: typeof AgentTool.ReadFile;
  readonly path: string;
  readonly shown: LineSpan;
  readonly totalLines: number;
  readonly lines: readonly string[];
}

export interface SearchRecord {
  readonly tool: typeof AgentTool.Search;
  readonly query: string;
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
}

export interface CompileRecord {
  readonly tool: typeof AgentTool.Compile;
  readonly diagnostics: readonly CompileDiagnostic[];
}

export type ToolRecord = ReadRecord | SearchRecord | CompileRecord;

export function createReadRecord(
  path: string,
  shown: LineSpan,
  totalLines: number,
  lines: readonly string[],
): ReadRecord {
  const isEmpty = totalLines === 0 && shown.first === 1 && shown.last === 0;
  const isInside = shown.first >= 1 && shown.first <= shown.last && shown.last <= totalLines;
  if (!isEmpty && !isInside) {
    throw new InvalidToolRecordError(
      `lines ${String(shown.first)}-${String(shown.last)} are not inside the ${String(totalLines)} lines of ${path}`,
    );
  }
  if (lines.length !== shown.last - shown.first + 1) {
    throw new InvalidToolRecordError(
      `${String(lines.length)} lines were recorded for lines ${String(shown.first)}-${String(shown.last)} of ${path}`,
    );
  }
  return Object.freeze({
    tool: AgentTool.ReadFile,
    path,
    shown: Object.freeze({ ...shown }),
    totalLines,
    lines: Object.freeze([...lines]),
  });
}

export function recordToolTurn({ call, result }: ToolTurn): ToolRecord {
  switch (result.tool) {
    case AgentTool.ReadFile:
      return createReadRecord(
        result.path,
        result.shown,
        result.document.lines.length,
        result.document.lines.slice(result.shown.first - 1, result.shown.last),
      );
    case AgentTool.Search:
      if (call.tool !== AgentTool.Search) {
        throw new InvariantViolation(`a search result came from a ${call.tool} call`);
      }
      return { ...result, query: call.query };
    case AgentTool.Compile:
      return result;
  }
}

export interface ToolTurn {
  readonly kind: 'tool';
  readonly call: ToolCall;
  readonly result: ToolResult;
}

export interface MistakeTurn {
  readonly kind: 'mistake';
  readonly decision: AgentDecision;
  readonly problem: string;
}

export type AgentTurn = ToolTurn | MistakeTurn;

export function getToolTurns(transcript: readonly AgentTurn[]): readonly ToolTurn[] {
  return transcript.filter((turn) => turn.kind === 'tool');
}

export interface OpenFileView {
  readonly path: string;
  readonly document: DocumentSnapshot;
}

export interface ShownDocument {
  readonly document: DocumentSnapshot;
  readonly spans: readonly LineSpan[];
}

export function getShownDocument(
  openFile: OpenFileView,
  transcript: readonly AgentTurn[],
  path: string,
): ShownDocument {
  const reads = getToolTurns(transcript).flatMap(({ result }) =>
    result.tool === AgentTool.ReadFile && result.path === path ? [result] : [],
  );
  const latest = reads.at(-1);
  if (latest !== undefined) {
    const current = reads.filter((read) => isSameDocument(read.document, latest.document));
    return { document: latest.document, spans: current.map((read) => read.shown) };
  }
  if (openFile.path === path) {
    return {
      document: openFile.document,
      spans: [{ first: 1, last: openFile.document.lines.length }],
    };
  }
  throw new UnreadFileEditError(`${path} must be read with read_file before it can be edited`);
}

export function assertEditShown(
  path: string,
  shown: ShownDocument,
  command: DocumentCommand,
): void {
  const { first, last } = getEditedLines(command);
  for (let line = first; line <= last; line += 1) {
    if (!shown.spans.some((span) => span.first <= line && line <= span.last)) {
      throw new UnshownLinesEditError(
        `line ${String(line)} of ${path} was not shown to you; read lines ${String(first)} to ${String(last)} with read_file (START_LINE and END_LINE) before editing them`,
      );
    }
  }
}

function getEditedLines(command: DocumentCommand): LineSpan {
  const first = command.target.lineNumber;
  switch (command.operation) {
    case DocumentOperation.InsertBefore:
    case DocumentOperation.InsertAfter:
      return { first, last: first };
    case DocumentOperation.Replace:
    case DocumentOperation.Delete:
      return { first, last: first + command.lineCount - 1 };
  }
}
