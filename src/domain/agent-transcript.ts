import { AgentTool, type AgentDecision, type ToolCall } from './agent-action';
import { isSameDocument, type DocumentSnapshot } from './document';
import { DocumentOperation, type DocumentCommand } from './document-command';
import { UnreadFileEditError, UnshownLinesEditError } from './errors';
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
