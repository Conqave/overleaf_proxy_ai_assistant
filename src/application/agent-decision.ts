import {
  AgentTool,
  type AgentDecision,
  type AgentReply,
  type DelegateCall,
  type ProjectEdit,
  type ToolCall,
  type WebSearchCall,
} from '../domain/agent-action';
import { checkEditCount, type EditRequest } from '../domain/change-set';
import {
  checkFilesChecked,
  checkReply,
  checkToolCall,
  type AgentPolicy,
} from '../domain/agent-policy';
import { assertEditShown, getShownDocument, type AgentTurn } from '../domain/agent-transcript';
import { AgentMistakeError } from '../domain/errors';
import { checkSeparateEdits } from '../domain/file-change';
import { findSearchScope, findTextFile, type TextFile } from '../domain/project-file';
import { ResolvedEdit } from '../domain/resolved-edit';
import type { ReadRange } from '../domain/read-window';
import type { AgentRequest, AgentWorkspace } from '../ports/agent-port';
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

export interface AcceptedWebSearch {
  readonly kind: 'web-search';
  readonly call: WebSearchCall;
}

export type AcceptedDecision =
  | { readonly kind: 'tool'; readonly call: ToolCall; readonly run: ProjectToolRun }
  | AcceptedDelegation
  | AcceptedWebSearch
  | AcceptedReply;

export function acceptDecision(
  decision: AgentDecision,
  { request, policy }: { readonly request: AgentRequest; readonly policy: AgentPolicy },
  workspace: AgentWorkspace,
  transcript: readonly AgentTurn[],
): AcceptedDecision {
  if (decision.kind === 'reply') {
    checkReply(policy, decision.reply);
    if (request.kind === 'subtask') checkFilesChecked(policy, transcript, request.files);
    return acceptReply(decision.reply, workspace, transcript);
  }
  const { call } = decision;
  checkToolCall(policy, transcript, call);
  switch (call.tool) {
    case AgentTool.Delegate:
      return {
        kind: 'delegate',
        call,
        files: [...new Set(call.files.flatMap((path) => findSearchScope(workspace.files, path)))],
      };
    case AgentTool.WebSearch:
      return { kind: 'web-search', call };
    case AgentTool.ReadFile:
    case AgentTool.Search:
    case AgentTool.Compile:
      return { kind: 'tool', call, run: planToolRun(call, workspace) };
  }
}

function planToolRun(
  call: Exclude<ToolCall, DelegateCall | WebSearchCall>,
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
      checkEditCount(reply.edits.length);
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
    if (!(error instanceof AgentMistakeError)) throw error;
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
