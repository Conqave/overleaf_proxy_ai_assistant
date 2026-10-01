import type { DocumentCommand } from './document-command';
import type { ResolvedEdit } from './resolved-edit';
import { createProjectPath, type TextFile } from './project-file';
import { InvalidProjectPathError, InvalidToolCallError } from './errors';

export const AgentTool = {
  ReadFile: 'read_file',
  Search: 'search',
  Compile: 'compile',
} as const;
export type AgentTool = (typeof AgentTool)[keyof typeof AgentTool];

export type ToolCall =
  | { readonly tool: typeof AgentTool.ReadFile; readonly path: string }
  | { readonly tool: typeof AgentTool.Search; readonly query: string }
  | { readonly tool: typeof AgentTool.Compile };

export interface ToolCallInput {
  readonly tool: unknown;
  readonly path?: unknown;
  readonly query?: unknown;
}

export const SEARCH_QUERY_CHARS = { min: 2, max: 200 } as const;

const TOOLS: readonly string[] = Object.values(AgentTool);

function isAgentTool(value: unknown): value is AgentTool {
  return typeof value === 'string' && TOOLS.includes(value);
}

export function createToolCall(input: ToolCallInput): ToolCall {
  const { tool } = input;
  if (!isAgentTool(tool)) {
    throw new InvalidToolCallError(`unknown tool: ${JSON.stringify(tool)}`);
  }
  switch (tool) {
    case AgentTool.ReadFile:
      rejectArgument(tool, 'query', input.query);
      return Object.freeze({ tool, path: parsePath(input.path) });
    case AgentTool.Search:
      rejectArgument(tool, 'path', input.path);
      return Object.freeze({ tool, query: parseQuery(input.query) });
    case AgentTool.Compile:
      rejectArgument(tool, 'path', input.path);
      rejectArgument(tool, 'query', input.query);
      return Object.freeze({ tool });
  }
}

export function isSameToolCall(first: ToolCall, second: ToolCall): boolean {
  switch (first.tool) {
    case AgentTool.ReadFile:
      return second.tool === AgentTool.ReadFile && second.path === first.path;
    case AgentTool.Search:
      return second.tool === AgentTool.Search && second.query === first.query;
    case AgentTool.Compile:
      return second.tool === AgentTool.Compile;
  }
}

function rejectArgument(tool: AgentTool, name: string, value: unknown): void {
  if (value !== undefined) throw new InvalidToolCallError(`${tool} takes no ${name}`);
}

function parsePath(value: unknown): string {
  if (value === undefined) throw new InvalidToolCallError('read_file requires a path');
  try {
    return createProjectPath(value);
  } catch (error) {
    if (!(error instanceof InvalidProjectPathError)) throw error;
    throw new InvalidToolCallError(error.message, { cause: error });
  }
}

function parseQuery(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidToolCallError('search requires a query');
  const query = value.trim();
  if (query.includes('\n')) throw new InvalidToolCallError('the search query must be one line');
  if (query.length < SEARCH_QUERY_CHARS.min || query.length > SEARCH_QUERY_CHARS.max) {
    throw new InvalidToolCallError(
      `the search query must have ${String(SEARCH_QUERY_CHARS.min)} to ${String(SEARCH_QUERY_CHARS.max)} characters`,
    );
  }
  return query;
}

export interface ProjectEdit {
  readonly file: TextFile;
  readonly edit: ResolvedEdit;
}

export type AgentReply =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'question'; readonly text: string }
  | { readonly kind: 'edit'; readonly path: string; readonly command: DocumentCommand };

export type AgentDecision =
  | { readonly kind: 'tool'; readonly call: ToolCall }
  | { readonly kind: 'reply'; readonly reply: AgentReply };
