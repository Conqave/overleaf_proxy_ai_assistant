import {
  AgentTool,
  type AgentDecision,
  type AgentReply,
  type DelegateCall,
  type ProjectEdit,
  type ToolCall,
} from '../domain/agent-action';
import type { EditRequest } from '../domain/change-set';
import { checkReply, checkToolCall, type AgentPolicy } from '../domain/agent-policy';
import { assertEditShown, getShownDocument, type AgentTurn } from '../domain/agent-transcript';
import {
  DelegationLimitError,
  DocumentRangeError,
  DocumentTargetNotFoundError,
  NotATextFileError,
  OverlappingEditsError,
  ProjectFileNotFoundError,
  ReadRangeError,
  ReplyNotAllowedError,
  RepeatedToolCallError,
  ToolBudgetExhaustedError,
  ToolNotAllowedError,
  UnreadFileEditError,
  UnshownLinesEditError,
} from '../domain/errors';
import { checkSeparateEdits } from '../domain/file-change';
import { findSearchScope, findTextFile, type TextFile } from '../domain/project-file';
import { ResolvedEdit } from '../domain/resolved-edit';
import type { ReadRange } from '../domain/read-window';
import type { AgentWorkspace } from '../ports/agent-port';
import { InvalidChangeSetEditError } from './errors';

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

export type AcceptedReply =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'question'; readonly text: string }
  | { readonly kind: 'edit'; readonly changes: readonly ProjectEdit[] };

export interface AcceptedDelegation {
  readonly kind: 'delegate';
  readonly call: DelegateCall;
  readonly files: readonly TextFile[];
}

export type AcceptedDecision =
  | { readonly kind: 'tool'; readonly call: ToolCall; readonly run: ProjectToolRun }
  | AcceptedDelegation
  | AcceptedReply;

export type AgentMistake =
  | ToolNotAllowedError
  | ReplyNotAllowedError
  | DelegationLimitError
  | ToolBudgetExhaustedError
  | RepeatedToolCallError
  | ProjectFileNotFoundError
  | NotATextFileError
  | UnreadFileEditError
  | UnshownLinesEditError
  | ReadRangeError
  | DocumentTargetNotFoundError
  | DocumentRangeError
  | OverlappingEditsError
  | InvalidChangeSetEditError;

export function isAgentMistake(error: unknown): error is AgentMistake {
  return (
    error instanceof ToolNotAllowedError ||
    error instanceof ReplyNotAllowedError ||
    error instanceof DelegationLimitError ||
    error instanceof ToolBudgetExhaustedError ||
    error instanceof RepeatedToolCallError ||
    error instanceof ProjectFileNotFoundError ||
    error instanceof NotATextFileError ||
    error instanceof UnreadFileEditError ||
    error instanceof UnshownLinesEditError ||
    error instanceof ReadRangeError ||
    error instanceof DocumentTargetNotFoundError ||
    error instanceof DocumentRangeError ||
    error instanceof OverlappingEditsError ||
    error instanceof InvalidChangeSetEditError
  );
}

export function acceptDecision(
  decision: AgentDecision,
  policy: AgentPolicy,
  workspace: AgentWorkspace,
  transcript: readonly AgentTurn[],
): AcceptedDecision {
  if (decision.kind === 'reply') {
    checkReply(policy, decision.reply);
    return acceptReply(decision.reply, workspace, transcript);
  }
  const { call } = decision;
  checkToolCall(policy, transcript, call);
  if (call.tool === AgentTool.Delegate) {
    return {
      kind: 'delegate',
      call,
      files: call.files.map((path) => findTextFile(workspace.files, path)),
    };
  }
  return { kind: 'tool', call, run: planToolRun(call, workspace) };
}

function planToolRun(
  call: Exclude<ToolCall, DelegateCall>,
  workspace: AgentWorkspace,
): ProjectToolRun {
  switch (call.tool) {
    case AgentTool.ReadFile:
      return { tool: call.tool, file: findTextFile(workspace.files, call.path), range: call.range };
    case AgentTool.Search:
      return {
        tool: call.tool,
        query: call.query,
        files: findSearchScope(workspace.files, call.path),
      };
    case AgentTool.Compile:
      return { tool: call.tool };
  }
}

function acceptReply(
  reply: AgentReply,
  workspace: AgentWorkspace,
  transcript: readonly AgentTurn[],
): AcceptedReply {
  switch (reply.kind) {
    case 'answer':
    case 'question':
      return { kind: reply.kind, text: reply.text };
    case 'edit': {
      const changes = reply.edits.map((request, index) =>
        reply.edits.length === 1
          ? acceptEdit(request, workspace, transcript)
          : acceptEditOfMany(request, index, reply.edits.length, workspace, transcript),
      );
      checkSeparateEdits(changes.map(({ file, edit }) => ({ path: file.path, edit })));
      return { kind: 'edit', changes };
    }
  }
}

function acceptEditOfMany(
  request: EditRequest,
  index: number,
  count: number,
  workspace: AgentWorkspace,
  transcript: readonly AgentTurn[],
): ProjectEdit {
  try {
    return acceptEdit(request, workspace, transcript);
  } catch (error) {
    if (!isAgentMistake(error)) throw error;
    throw new InvalidChangeSetEditError(index, count, request.path, error);
  }
}

function acceptEdit(
  { path, command }: EditRequest,
  workspace: AgentWorkspace,
  transcript: readonly AgentTurn[],
): ProjectEdit {
  const file = findTextFile(workspace.files, path);
  const shown = getShownDocument(workspace.openFile, transcript, file.path, command);
  const edit = ResolvedEdit.resolve(shown.document, command);
  assertEditShown(file.path, shown, edit.command, transcript);
  return { file, edit };
}
