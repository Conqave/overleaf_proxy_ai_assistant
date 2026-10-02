import type { EditRequest } from './change-set';
import type { ResolvedEdit } from './resolved-edit';
import { createProjectPath, type TextFile } from './project-file';
import { InvalidProjectPathError, InvalidToolCallError } from './errors';
import { createReadRange, isSameReadRange, type ReadRange } from './read-window';

export const AgentTool = {
  ReadFile: 'read_file',
  Search: 'search',
  Compile: 'compile',
  Delegate: 'delegate',
} as const;
export type AgentTool = (typeof AgentTool)[keyof typeof AgentTool];

export type ToolCall =
  | { readonly tool: typeof AgentTool.ReadFile; readonly path: string; readonly range?: ReadRange }
  | { readonly tool: typeof AgentTool.Search; readonly query: string }
  | { readonly tool: typeof AgentTool.Compile }
  | DelegateCall;

export interface DelegateCall {
  readonly tool: typeof AgentTool.Delegate;
  readonly task: string;
  readonly files: readonly string[];
}

export interface ToolCallInput {
  readonly tool: unknown;
  readonly path?: unknown;
  readonly query?: unknown;
  readonly startLine?: unknown;
  readonly endLine?: unknown;
  readonly task?: unknown;
  readonly files?: unknown;
}

export const SEARCH_QUERY_CHARS = { min: 2, max: 200 } as const;

export const DELEGATION_TASK_CHARS = { min: 10, max: 1_000 } as const;

export const MAX_DELEGATION_FILES = 20;

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
    case AgentTool.ReadFile: {
      rejectArgument(tool, 'query', input.query);
      rejectDelegationArguments(tool, input);
      const path = parsePath(input.path);
      const range = createReadRange(input.startLine, input.endLine);
      return Object.freeze(range === undefined ? { tool, path } : { tool, path, range });
    }
    case AgentTool.Search:
      rejectArgument(tool, 'path', input.path);
      rejectLineArguments(tool, input);
      rejectDelegationArguments(tool, input);
      return Object.freeze({ tool, query: parseQuery(input.query) });
    case AgentTool.Compile:
      rejectArgument(tool, 'path', input.path);
      rejectArgument(tool, 'query', input.query);
      rejectLineArguments(tool, input);
      rejectDelegationArguments(tool, input);
      return Object.freeze({ tool });
    case AgentTool.Delegate:
      rejectArgument(tool, 'path', input.path);
      rejectArgument(tool, 'query', input.query);
      rejectLineArguments(tool, input);
      return createDelegateCall(input.task, input.files);
  }
}

export function createDelegateCall(task: unknown, files: unknown): DelegateCall {
  return Object.freeze({
    tool: AgentTool.Delegate,
    task: parseTask(task),
    files: parseFileHints(files),
  });
}

export function isSameToolCall(first: ToolCall, second: ToolCall): boolean {
  switch (first.tool) {
    case AgentTool.ReadFile:
      return (
        second.tool === AgentTool.ReadFile &&
        second.path === first.path &&
        isSameReadRange(first.range, second.range)
      );
    case AgentTool.Search:
      return second.tool === AgentTool.Search && second.query === first.query;
    case AgentTool.Compile:
      return second.tool === AgentTool.Compile;
    case AgentTool.Delegate:
      return second.tool === AgentTool.Delegate && second.task === first.task;
  }
}

function rejectArgument(tool: AgentTool, name: string, value: unknown): void {
  if (value !== undefined) throw new InvalidToolCallError(`${tool} takes no ${name}`);
}

function rejectLineArguments(tool: AgentTool, input: ToolCallInput): void {
  rejectArgument(tool, 'start line', input.startLine);
  rejectArgument(tool, 'end line', input.endLine);
}

function rejectDelegationArguments(tool: AgentTool, input: ToolCallInput): void {
  rejectArgument(tool, 'task', input.task);
  rejectArgument(tool, 'files', input.files);
}

function parsePath(value: unknown): string {
  if (value === undefined) throw new InvalidToolCallError('read_file requires a path');
  return parseToolPath(value);
}

function parseToolPath(value: unknown): string {
  try {
    return createProjectPath(value);
  } catch (error) {
    if (!(error instanceof InvalidProjectPathError)) throw error;
    throw new InvalidToolCallError(error.message, { cause: error });
  }
}

function parseTask(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidToolCallError('delegate requires a task');
  const task = value.trim();
  if (task.includes('\n')) throw new InvalidToolCallError('the task must be one line');
  if (task.length < DELEGATION_TASK_CHARS.min || task.length > DELEGATION_TASK_CHARS.max) {
    throw new InvalidToolCallError(
      `the task must have ${String(DELEGATION_TASK_CHARS.min)} to ${String(DELEGATION_TASK_CHARS.max)} characters`,
    );
  }
  return task;
}

function parseFileHints(values: unknown): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) throw new InvalidToolCallError('the files of a task must be a list');
  if (values.length > MAX_DELEGATION_FILES) {
    throw new InvalidToolCallError(
      `a task names at most ${String(MAX_DELEGATION_FILES)} files, got ${String(values.length)}`,
    );
  }
  const files = values.map(parseToolPath);
  const repeated = files.find((path, index) => files.indexOf(path) !== index);
  if (repeated !== undefined) {
    throw new InvalidToolCallError(`${repeated} is named twice among the task's files`);
  }
  return Object.freeze(files);
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
  | { readonly kind: 'edit'; readonly edits: readonly EditRequest[] };

export type AgentDecision =
  | { readonly kind: 'tool'; readonly call: ToolCall }
  | { readonly kind: 'reply'; readonly reply: AgentReply };
