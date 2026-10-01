import { AgentTool, type AgentDecision, type ToolCall } from '../../domain/agent-action';
import { AGENT_POLICY, canCallTools } from '../../domain/agent-policy';
import type { AgentTurn, CompileDiagnostic, ToolResult } from '../../domain/agent-transcript';
import type { DocumentSnapshot } from '../../domain/document';
import { DocumentOperation } from '../../domain/document-command';
import { ProjectFileKind, type ProjectFile } from '../../domain/project-file';
import type { AgentStepRequest } from '../../ports/agent-port';
import { AGENT_ACTIONS, AgentAction, AgentField, TEXT_MARKER } from './agent-reply-format';
import { parseAgentDecision } from './agent-response-parser';
import {
  block,
  blockHeading,
  conversationBlock,
  CONVERSATION_LABEL,
  createTooLargeError,
  EDIT_FORMAT,
  EDIT_RULES,
  LANGUAGE_RULE,
  LINE_BREAK,
  lines,
  minBlockChars,
  SELECTION_LABEL,
  SMALL_BLOCK_SHARE,
  userMessage,
  type ProtocolExchange,
} from './assistant-protocol';
import { CONTENT_MARKER, EditField, fieldLine } from './edit-reply-format';

const OPEN_FILE_SHARE = 2;

const FILES_LABEL = 'Project files:';
const SMALL_BLOCK_LABELS: readonly string[] = [FILES_LABEL, CONVERSATION_LABEL, SELECTION_LABEL];
const NO_PROBLEMS = '(no problems)';
const NO_MATCHES = '(no matches)';
const MORE_MATCHES = '(more matches omitted; search for something more specific)';

const A = AgentAction;
const F = EditField;

const actionLine = (action: AgentAction): string => fieldLine(AgentField.Action, action);

const AGENT_SYSTEM = lines(
  'You are Hans, an assistant built into the Overleaf LaTeX editor. You help with the whole LaTeX project: all files under "Project files"; one of them is open in the editor and shown to you with numbered lines.',
  LANGUAGE_RULE,
  `Every reply is exactly one action written as plain text lines in the reply itself. The first line is always ${fieldLine(AgentField.Action, '<action>')}. No JSON, no markdown fences, nothing before or after.`,
  'You have no functions and no tools to call. Never send a message to a recipient or a function: the whole reply goes to the final channel as plain text, including read_file, search and compile, which are only lines of text that the editor reads.',
  '',
  'Lookups collect information you do not have yet. A lookup is your final answer for this turn: write its lines as the final answer and stop. The editor then performs it and asks you again with its outcome added as "Result N".',
  `- ${A.ReadFile}: shows the numbered lines of one text file of the project.`,
  actionLine(A.ReadFile),
  fieldLine(AgentField.Path, 'sample.bib'),
  `- ${A.Search}: finds a text in every text file of the project, case-insensitively, and lists each matching line as path:line: text. Use it to find where a \\label, \\cite key, \\ref, command or phrase is.`,
  actionLine(A.Search),
  fieldLine(AgentField.Query, '\\label{fig:frog}'),
  `- ${A.Compile}: compiles the project and lists its errors and warnings. Use it only when the request is about compile errors, warnings or a broken build.`,
  actionLine(A.Compile),
  '',
  'Replies end the request.',
  `- ${A.Answer}: an explanation, summary or answer; the text after ${TEXT_MARKER} may span several lines.`,
  actionLine(A.Answer),
  TEXT_MARKER,
  '<the answer>',
  `- ${A.Question}: only when you cannot act at all. Details the user leaves open, such as the exact wording or an example sentence, you write yourself and still reply with ${A.Edit}.`,
  actionLine(A.Question),
  fieldLine(F.Question, '<one short question>'),
  `- ${A.Edit}: exactly one change of one file (an insertion around a line, or a replacement or deletion of one line or a range of consecutive lines). Every request to add, change, remove, fix, rewrite or translate content of a file ends with an ${A.Edit} that the user reviews and applies, never with the new text in an ${A.Answer}; translating the selected text means replacing it in its file.`,
  actionLine(A.Edit),
  fieldLine(AgentField.Path, '<file path exactly as listed under Project files>'),
  EDIT_FORMAT,
  '',
  'How to work:',
  '- The open file is already shown with numbered lines: never read it; answer or edit it directly.',
  `- Any other file must be read with ${A.ReadFile} before you edit it or quote it.`,
  `- ${AgentField.Path} is always a path exactly as listed under Project files; files marked (binary) cannot be read or edited. If a file the user names is not listed, say so in an ${A.Answer}.`,
  `- Use ${A.Search} to find labels, citations, commands or text when you do not know which file has them.`,
  `- When the user says the project does not compile or reports errors or warnings, start with ${A.Compile}, then read the file it names.`,
  `- Verbs such as translate, fix, change, add, remove, rewrite (przetłumacz, popraw, zmień, dodaj, usuń, przepisz) applied to text of a file ask for an ${A.Edit} of that file.`,
  '- Reply as soon as you know enough. Never repeat a lookup; use the result you already have.',
  '- When "Lookups left" is 0, reply now with answer, question or edit.',
  '- Base answers on the files; do not invent content they do not have. Quote LaTeX exactly.',
  '',
  EDIT_RULES,
  '',
  'Example of a lookup:',
  actionLine(A.Search),
  fieldLine(AgentField.Query, 'greenwade93'),
  'Example of an answer:',
  actionLine(A.Answer),
  TEXT_MARKER,
  'Bibliografia jest w pliku sample.bib i używa stylu alpha (main.tex, linia 40).',
  'Example of an edit of a file read before:',
  actionLine(A.Edit),
  fieldLine(AgentField.Path, 'sample.bib'),
  fieldLine(F.Operation, DocumentOperation.InsertAfter),
  fieldLine(F.Line, '12'),
  fieldLine(F.LineText, '}'),
  fieldLine(F.Reason, 'Dodaję brakujący wpis knuth84.'),
  fieldLine(F.Plan, 'Nowy wpis po ostatnim wpisie.'),
  CONTENT_MARKER,
  '@book{knuth84,',
  '  author = {Donald Knuth},',
  '  title = {The TeXbook},',
  '  year = {1984}',
  '}',
);

const RETRY = `Reply again with exactly one action: the first line ${fieldLine(AgentField.Action, AGENT_ACTIONS.join('|'))}, then only the lines that action takes. No JSON.`;

export function createAgentExchange(
  request: AgentStepRequest,
  budget: number,
): ProtocolExchange<AgentDecision> {
  return {
    request: { system: AGENT_SYSTEM, prompt: buildPrompt(request, budget - AGENT_SYSTEM.length) },
    retryInstruction: RETRY,
    parse: (raw) => parseAgentDecision(raw, request),
  };
}

interface PromptBlock {
  readonly label: string;
  readonly text: string;
}

interface RenderedBlocks {
  readonly open: string;
  readonly results: readonly string[];
}

function buildPrompt(request: AgentStepRequest, budget: number): string {
  const { workspace, transcript } = request;
  const smallBlock = Math.floor(budget / SMALL_BLOCK_SHARE);
  if (SMALL_BLOCK_LABELS.some((label) => smallBlock < minBlockChars(label))) {
    throw createTooLargeError();
  }
  const before = [
    userMessage(request.message),
    ...conversationBlock(request.conversation, smallBlock),
    block(FILES_LABEL, fileList(workspace.files, workspace.openFile.path), smallBlock),
  ];
  const after = [
    ...(workspace.selection === ''
      ? []
      : [block(SELECTION_LABEL, workspace.selection, smallBlock)]),
    `${LINE_BREAK}${toolsLeft(transcript)}`,
  ];
  const open = {
    label: `Numbered lines of ${workspace.openFile.path} (open in the editor, caret on line ${String(workspace.cursorLine)}):`,
    text: numberLines(workspace.openFile.document),
  };
  const results = transcript.map((turn, index) => ({
    label: resultLabel(index + 1, turn.call),
    text: resultText(turn.result),
  }));
  const separators = (results.length + 2) * LINE_BREAK.length;
  const available = budget - lines(...before, ...after).length - separators;
  const rendered = renderBlocks(available, open, results);
  return lines(...before, rendered.open, ...rendered.results, ...after);
}

function renderBlocks(
  available: number,
  open: PromptBlock,
  results: readonly PromptBlock[],
): RenderedBlocks {
  const resultFloors = sum(results.map(floorSize));
  if (available < floorSize(open) + resultFloors) throw createTooLargeError();
  const preferred = Math.max(
    Math.floor(available / OPEN_FILE_SHARE),
    available - sum(results.map(fullSize)),
  );
  const openShare = Math.max(
    floorSize(open),
    Math.min(fullSize(open), preferred, available - resultFloors),
  );
  const rendered: string[] = [];
  let remaining = available - openShare;
  let olderFloors = resultFloors;
  for (const result of [...results].reverse()) {
    olderFloors -= floorSize(result);
    const share = Math.min(fullSize(result), remaining - olderFloors);
    remaining -= share;
    rendered.unshift(block(result.label, result.text, share));
  }
  return { open: block(open.label, open.text, openShare), results: rendered };
}

function fullSize(promptBlock: PromptBlock): number {
  return blockHeading(promptBlock.label).length + promptBlock.text.length;
}

function floorSize(promptBlock: PromptBlock): number {
  return Math.min(fullSize(promptBlock), minBlockChars(promptBlock.label));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function fileList(files: readonly ProjectFile[], openPath: string): string {
  return files.map((file) => `${file.path}${fileNote(file, openPath)}`).join(LINE_BREAK);
}

function fileNote(file: ProjectFile, openPath: string): string {
  if (file.kind === ProjectFileKind.Binary) return ' (binary)';
  if (file.path === openPath) return ' (open in the editor)';
  return '';
}

function toolsLeft(transcript: readonly AgentTurn[]): string {
  if (!canCallTools(transcript)) {
    return `Lookups left: 0. Reply now with ${fieldLine(AgentField.Action, `${A.Answer}, ${A.Question} or ${A.Edit}`)}.`;
  }
  return `Lookups left: ${String(AGENT_POLICY.maxToolCalls - transcript.length)}`;
}

function numberLines(document: DocumentSnapshot): string {
  return document.lines.map((line, index) => `${String(index + 1)}: ${line}`).join(LINE_BREAK);
}

function resultLabel(position: number, call: ToolCall): string {
  return `Result ${String(position)} (${describeCall(call)}):`;
}

function describeCall(call: ToolCall): string {
  switch (call.tool) {
    case AgentTool.ReadFile:
      return `${call.tool} ${call.path}`;
    case AgentTool.Search:
      return `${call.tool} ${JSON.stringify(call.query)}`;
    case AgentTool.Compile:
      return call.tool;
  }
}

function resultText(result: ToolResult): string {
  switch (result.tool) {
    case AgentTool.ReadFile:
      return numberLines(result.document);
    case AgentTool.Search: {
      const found = result.matches.map(
        (match) => `${match.path}:${String(match.lineNumber)}: ${match.lineText}`,
      );
      const listed = found.length ? found : [NO_MATCHES];
      return lines(...listed, ...(result.truncated ? [MORE_MATCHES] : []));
    }
    case AgentTool.Compile:
      return result.diagnostics.length
        ? result.diagnostics.map(diagnosticLine).join(LINE_BREAK)
        : NO_PROBLEMS;
  }
}

function diagnosticLine(diagnostic: CompileDiagnostic): string {
  return `${diagnostic.level} ${diagnosticPlace(diagnostic)}${diagnostic.message}`;
}

function diagnosticPlace({ path, lineNumber }: CompileDiagnostic): string {
  if (path === undefined) return '';
  if (lineNumber === undefined) return `${path}: `;
  return `${path}:${String(lineNumber)}: `;
}
