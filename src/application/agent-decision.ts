import {
  AgentTool,
  type AgentDecision,
  type AgentReply,
  type ProjectEdit,
  type ToolCall,
} from '../domain/agent-action';
import { checkToolCall } from '../domain/agent-policy';
import { assertEditShown, getShownDocument, type AgentTurn } from '../domain/agent-transcript';
import {
  DocumentRangeError,
  DocumentTargetNotFoundError,
  NotATextFileError,
  ProjectFileNotFoundError,
  ReadRangeError,
  RepeatedToolCallError,
  ToolBudgetExhaustedError,
  UnreadFileEditError,
  UnshownLinesEditError,
} from '../domain/errors';
import { findTextFile, listTextFiles, type TextFile } from '../domain/project-file';
import { ResolvedEdit } from '../domain/resolved-edit';
import type { ReadRange } from '../domain/read-window';
import type { AgentWorkspace } from '../ports/agent-port';

export type ProjectToolRun =
  | {
      readonly tool: typeof AgentTool.ReadFile;
      readonly file: TextFile;
      readonly range: ReadRange | undefined;
    }
  | {
      readonly tool: typeof AgentTool.Search;
      readonly query: string;
      readonly files: readonly TextFile[];
    }
  | { readonly tool: typeof AgentTool.Compile };

export type AcceptedDecision =
  | { readonly kind: 'tool'; readonly call: ToolCall; readonly run: ProjectToolRun }
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'question'; readonly text: string }
  | { readonly kind: 'edit'; readonly change: ProjectEdit };

export type AgentMistake =
  | ToolBudgetExhaustedError
  | RepeatedToolCallError
  | ProjectFileNotFoundError
  | NotATextFileError
  | UnreadFileEditError
  | UnshownLinesEditError
  | ReadRangeError
  | DocumentTargetNotFoundError
  | DocumentRangeError;

export function isAgentMistake(error: unknown): error is AgentMistake {
  return (
    error instanceof ToolBudgetExhaustedError ||
    error instanceof RepeatedToolCallError ||
    error instanceof ProjectFileNotFoundError ||
    error instanceof NotATextFileError ||
    error instanceof UnreadFileEditError ||
    error instanceof UnshownLinesEditError ||
    error instanceof ReadRangeError ||
    error instanceof DocumentTargetNotFoundError ||
    error instanceof DocumentRangeError
  );
}

export function acceptDecision(
  decision: AgentDecision,
  workspace: AgentWorkspace,
  transcript: readonly AgentTurn[],
): AcceptedDecision {
  if (decision.kind === 'reply') return acceptReply(decision.reply, workspace, transcript);
  checkToolCall(transcript, decision.call);
  return { kind: 'tool', call: decision.call, run: planToolRun(decision.call, workspace) };
}

function planToolRun(call: ToolCall, workspace: AgentWorkspace): ProjectToolRun {
  switch (call.tool) {
    case AgentTool.ReadFile:
      return { tool: call.tool, file: findTextFile(workspace.files, call.path), range: call.range };
    case AgentTool.Search:
      return { tool: call.tool, query: call.query, files: listTextFiles(workspace.files) };
    case AgentTool.Compile:
      return { tool: call.tool };
  }
}

function acceptReply(
  reply: AgentReply,
  workspace: AgentWorkspace,
  transcript: readonly AgentTurn[],
): AcceptedDecision {
  switch (reply.kind) {
    case 'answer':
    case 'question':
      return { kind: reply.kind, text: reply.text };
    case 'edit': {
      const file = findTextFile(workspace.files, reply.path);
      const shown = getShownDocument(workspace.openFile, transcript, file.path, reply.command);
      const edit = ResolvedEdit.resolve(shown.document, reply.command);
      assertEditShown(file.path, shown, edit.command, transcript);
      return { kind: 'edit', change: { file, edit } };
    }
  }
}
