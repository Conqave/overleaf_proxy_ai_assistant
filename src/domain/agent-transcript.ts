import { AgentTool, type ToolCall } from './agent-action';
import type { DocumentSnapshot } from './document';
import { UnreadFileEditError } from './errors';

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
    }
  | {
      readonly tool: typeof AgentTool.Search;
      readonly matches: readonly SearchMatch[];
      readonly truncated: boolean;
    }
  | { readonly tool: typeof AgentTool.Compile; readonly diagnostics: readonly CompileDiagnostic[] };

export interface AgentTurn {
  readonly call: ToolCall;
  readonly result: ToolResult;
}

export interface OpenFileView {
  readonly path: string;
  readonly document: DocumentSnapshot;
}

export function getShownDocument(
  openFile: OpenFileView,
  transcript: readonly AgentTurn[],
  path: string,
): DocumentSnapshot {
  const reads = transcript.flatMap(({ result }) =>
    result.tool === AgentTool.ReadFile && result.path === path ? [result.document] : [],
  );
  const latest = reads.at(-1);
  if (latest !== undefined) return latest;
  if (openFile.path === path) return openFile.document;
  throw new UnreadFileEditError(`${path} must be read with read_file before it can be edited`);
}
