import { AgentTool, type AgentDecision, type ToolCall } from '../../domain/agent-action';
import { countToolCallsLeft } from '../../domain/agent-policy';
import { recordToolTurn, type AgentTurn } from '../../domain/agent-transcript';
import type { ConversationMessage } from '../../domain/conversation';
import type { DocumentSnapshot } from '../../domain/document';
import { DocumentOperation } from '../../domain/document-command';
import { ProjectFileKind, type ProjectFile } from '../../domain/project-file';
import { InvariantViolation } from '../../domain/errors';
import { numberLine, READ_LIMITS } from '../../domain/read-window';
import type { AgentRequest, AgentStepRequest } from '../../ports/agent-port';
import { createMessageTooLargeError } from './context-budget';
import { getCorrectionReserveChars, type ProtocolExchange } from './correction-exchange';
import { parseAgentDecision } from './reply-parser';
import { diagnosticsText, renderRecord } from './tool-record-text';
import { conversationText } from './conversation-text';
import {
  AGENT_ACTIONS,
  AgentAction,
  AgentField,
  CONTENT,
  CONTENT_MARKER,
  EditField,
  fieldLine,
  TEXT_MARKER,
} from './reply-format';
import {
  block,
  blockHeading,
  CONVERSATION_LABEL,
  LINE_BREAK,
  lines,
  minBlockChars,
  SELECTION_LABEL,
  SMALL_BLOCK_SHARE,
  requestBlock,
} from './prompt-blocks';

const OPEN_FILE_SHARE = 2;
const HISTORY_SHARE = 4;

const FILES_LABEL = 'Project files:';
const SMALL_BLOCK_LABELS: readonly string[] = [FILES_LABEL, SELECTION_LABEL];
const REJECTED = 'rejected';
const COMPILE_RESULT_LABEL = 'Compile result after the applied change';

const A = AgentAction;
const F = EditField;

const LANGUAGE_RULE = `Write every user-facing text in the language of the user's latest message: the User message, or for a System request the user's last message shown with it (Polish message → Polish text). Text that goes into a file keeps the language of that file unless the user asks for a translation, and names and titles the user gives are used exactly as given, untranslated ("dodaj sekcję Conclusions" → \\section{Conclusions}).`;

const EDIT_FORMAT = lines(
  fieldLine(F.Operation, Object.values(DocumentOperation).join('|')),
  fieldLine(F.Line, '<line number>'),
  fieldLine(F.EndLine, '<last line number; only for a replace or delete that spans several lines>'),
  fieldLine(
    F.LineText,
    '<that line copied exactly from its start; for a long line its first sentence is enough>',
  ),
  `${fieldLine(F.Reason, '<short user-facing reason>')} (optional)`,
  CONTENT_MARKER,
  `<the new LaTeX lines, exactly as they go into the document; nothing else follows ${CONTENT_MARKER}>`,
);

const EDIT_RULES = lines(
  'Operations — the line numbers are those of the numbered lines of the file you edit:',
  `- insert_before / insert_after: ${CONTENT} is added before / after that line.`,
  `- replace: lines ${F.Line} to ${F.EndLine} (or just ${F.Line}) are swapped for ${CONTENT}. Keep everything that should stay, e.g. the \\label inside a \\caption.`,
  `- delete: lines ${F.Line} to ${F.EndLine} (or just ${F.Line}) are removed; ${CONTENT_MARKER} is left out or left empty.`,
  `- ${F.EndLine} only for replace and delete, only when the change spans several consecutive lines (a paragraph over several lines, a whole subsection with its text, an environment).`,
  'Targeting:',
  `- ${F.Line} is the number of the line and ${F.LineText} its text copied exactly from the start, without the "N: " prefix; for a long paragraph the first sentence is enough. Take ${F.Line} from the "N: " prefix of the very line you quote.`,
  '- Do not target \\begin{document}, \\maketitle, \\tableofcontents or preamble lines unless the user asks for that location.',
  '- New sections go after the end of the closest related section; with no sections yet, after \\maketitle.',
  '- Explanatory text goes before the table, figure, equation or listing it describes; captions and labels go inside their environment.',
  '- "after X" / "before X": target the line containing X. For a whole environment, target its \\end{name} line (after) or its \\begin{name} line (before).',
  '- Selected text, when given, is what the user means by "this", "zaznaczony", "the selection": change the line that contains it without asking.',
  `- When the request covers several consecutive lines, use one replace or delete with ${F.Line} and ${F.EndLine} instead of asking which line; when several places could match, choose the one most specifically about the request.`,
  'Content:',
  `- Everything after ${CONTENT_MARKER} is inserted verbatim: plain LaTeX source, one source line per line, no escaping, no fences, no Markdown.`,
  '- It must be valid LaTeX: close every environment you open.',
  '- When the user asks for new text without giving it (for example a section with one sentence), write suitable text yourself instead of asking.',
  '- Only the new or changed lines; never repeat unchanged surrounding lines and never rewrite the whole document.',
);

const actionLine = (action: AgentAction): string => fieldLine(AgentField.Action, action);

const AGENT_SYSTEM = lines(
  'You are Hans, an assistant built into the Overleaf LaTeX editor. You help with the whole LaTeX project: all files under "Project files"; one of them is open in the editor and shown to you with numbered lines.',
  LANGUAGE_RULE,
  `Every reply is exactly one action written as plain text lines in the reply itself. The first line is always ${fieldLine(AgentField.Action, '<action>')}. No JSON, no markdown fences, nothing before or after.`,
  'You have no functions and no tools to call. Never send a message to a recipient or a function: the whole reply goes to the final channel as plain text, including read_file, search and compile, which are only lines of text that the editor reads.',
  '',
  'Lookups collect information you do not have yet. A lookup is your final answer for this turn: write its lines as the final answer and stop. The editor then performs it and asks you again with its outcome added as "Result N".',
  `- ${A.ReadFile}: shows the numbered lines of one text file of the project, at most ${String(READ_LIMITS.maxLines)} lines or ${String(READ_LIMITS.maxChars)} characters at a time. For a long file add ${AgentField.StartLine} and ${EditField.EndLine} (line numbers, both optional) to read another part.`,
  actionLine(A.ReadFile),
  fieldLine(AgentField.Path, 'sample.bib'),
  `- ${A.Search}: finds a text in every text file of the project, case-insensitively, and lists each matching line as path:line: text. Use it to find where a \\label, \\cite key, \\ref, command or phrase is.`,
  actionLine(A.Search),
  fieldLine(AgentField.Query, '\\label{fig:frog}'),
  `- ${A.Compile}: compiles the project and lists its errors and warnings. Use it only when the request is about compile errors, warnings or a broken build.`,
  actionLine(A.Compile),
  '',
  'Replies end the request.',
  `- ${A.Answer}: an explanation, summary or answer; the text after ${TEXT_MARKER} may span several lines and may use Markdown (headings, lists, **bold**, \`inline code\`, tables, and fenced code blocks for LaTeX snippets).`,
  actionLine(A.Answer),
  TEXT_MARKER,
  '<the answer>',
  `- ${A.Question}: only when you cannot act at all. Details the user leaves open, such as the exact wording or an example sentence, you write yourself and still reply with ${A.Edit}.`,
  actionLine(A.Question),
  fieldLine(AgentField.Question, '<one short question>'),
  `- ${A.Edit}: exactly one change of one file (an insertion around a line, or a replacement or deletion of one line or a range of consecutive lines). Every request to add, change, remove, fix, rewrite or translate content of a file ends with an ${A.Edit} that the user reviews and applies, never with the new text in an ${A.Answer}; translating the selected text means replacing it in its file.`,
  actionLine(A.Edit),
  fieldLine(AgentField.Path, '<file path exactly as listed under Project files>'),
  EDIT_FORMAT,
  '',
  'How to work:',
  '- The open file is already shown with numbered lines: never read it; answer or edit it directly.',
  `- Any other file must be read with ${A.ReadFile} before you edit it or quote it; you can only edit lines that were shown to you.`,
  `- ${AgentField.Path} is always a path exactly as listed under Project files; files marked (binary) cannot be read or edited. If a file the user names is not listed, say so in an ${A.Answer}.`,
  `- A result "Showing lines A–B of N" shows only part of the file; lines up to N exist. Read the part you need with ${AgentField.StartLine} and ${EditField.EndLine}, or ${A.Search} for it, before you answer or edit.`,
  `- Use ${A.Search} to find labels, citations, commands or text when you do not know which file has them.`,
  `- When the user says the project does not compile or reports errors or warnings, your first action is ${A.Compile}, before any ${A.ReadFile}; then read the file it names and fix the first error it reports; the errors after it are often only its consequences, so change nothing else.`,
  `- A System request about compile errors comes with "${COMPILE_RESULT_LABEL}": do not ${A.Compile} again; read the file it names and fix the first error it reports.`,
  `- Verbs such as translate, fix, change, add, remove, rewrite (przetłumacz, popraw, zmień, dodaj, usuń, przepisz) applied to text of a file ask for an ${A.Edit} of that file.`,
  `- Verbs such as explain, describe, summarize (wyjaśnij, opisz, streść) ask for an ${A.Answer}; they never change a file.`,
  '- Reply as soon as you know enough. Never repeat a lookup; use the result you already have.',
  `- A result marked ${REJECTED} explains why your action at that step was not carried out; send a corrected action instead of repeating it.`,
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
  CONTENT_MARKER,
  '@book{knuth84,',
  '  author = {Donald Knuth},',
  '  title = {The TeXbook},',
  '  year = {1984}',
  '}',
  'Example of a deletion of a whole subsection (heading, blank line and paragraph):',
  actionLine(A.Edit),
  fieldLine(AgentField.Path, 'main.tex'),
  fieldLine(F.Operation, DocumentOperation.Delete),
  fieldLine(F.Line, '30'),
  fieldLine(F.EndLine, '33'),
  fieldLine(F.LineText, '\\subsection{Wyniki pomocnicze}'),
  fieldLine(F.Reason, 'Usuwam podsekcję z wynikami pomocniczymi.'),
);

const RETRY = `Reply again with exactly one action: the first line ${fieldLine(AgentField.Action, AGENT_ACTIONS.join('|'))}, then only the lines that action takes. No JSON.`;

const CORRECTION_RESERVE_CHARS = getCorrectionReserveChars(RETRY);

export function createAgentExchange(
  request: AgentStepRequest,
  promptChars: number,
): ProtocolExchange<AgentDecision> {
  const budget = promptChars - CORRECTION_RESERVE_CHARS - AGENT_SYSTEM.length;
  return {
    request: { system: AGENT_SYSTEM, prompt: buildPrompt(request, budget) },
    retryInstruction: RETRY,
    parse: parseAgentDecision,
  };
}

interface PromptBlock {
  readonly label: string;
  readonly text: string;
}

interface RenderedBlocks {
  readonly history: readonly string[];
  readonly open: string;
  readonly results: readonly string[];
}

function buildPrompt(request: AgentStepRequest, budget: number): string {
  const { workspace, transcript } = request;
  const requested = requestBlock(request.request, request.conversation);
  const smallBlock = Math.floor((budget - requested.length) / SMALL_BLOCK_SHARE);
  if (SMALL_BLOCK_LABELS.some((label) => smallBlock < minBlockChars(label))) {
    throw createMessageTooLargeError();
  }
  const files = block(FILES_LABEL, fileList(workspace.files, workspace.openFile.path), smallBlock);
  const after = [
    ...(workspace.selection === ''
      ? []
      : [block(SELECTION_LABEL, workspace.selection, smallBlock)]),
    `${LINE_BREAK}${toolsLeft(transcript)}`,
  ];
  const history = historyBlock(request.conversation);
  const open = {
    label: `Numbered lines of ${workspace.openFile.path} (open in the editor, caret on line ${String(workspace.cursorLine)}):`,
    text: numberLines(workspace.openFile.document),
  };
  const results = [
    ...attachedBlocks(request.request),
    ...transcript.map((turn, index) => turnBlock(index + 1, turn)),
  ];
  const separators = (history.length + results.length + 2) * LINE_BREAK.length;
  const available = budget - lines(requested, files, ...after).length - separators;
  const rendered = renderBlocks(available, history, open, results);
  return lines(requested, ...rendered.history, files, rendered.open, ...rendered.results, ...after);
}

function historyBlock(conversation: readonly ConversationMessage[]): PromptBlock[] {
  if (!conversation.length) return [];
  return [{ label: CONVERSATION_LABEL, text: conversationText(conversation) }];
}

function renderBlocks(
  available: number,
  history: readonly PromptBlock[],
  open: PromptBlock,
  results: readonly PromptBlock[],
): RenderedBlocks {
  const others = fullSize(open) + sum(results.map(fullSize));
  const historyShares = history.map((past) =>
    Math.max(
      floorSize(past),
      Math.min(fullSize(past), Math.max(available - others, Math.floor(available / HISTORY_SHARE))),
    ),
  );
  const current = renderCurrentBlocks(available - sum(historyShares), open, results);
  return {
    history: history.map((past, index) =>
      block(past.label, past.text, itemOf(historyShares, index)),
    ),
    ...current,
  };
}

function renderCurrentBlocks(
  available: number,
  open: PromptBlock,
  results: readonly PromptBlock[],
): Omit<RenderedBlocks, 'history'> {
  const resultFloors = sum(results.map(floorSize));
  if (available < floorSize(open) + resultFloors) throw createMessageTooLargeError();
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

function itemOf(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new InvariantViolation(`no share for block ${String(index)}`);
  return value;
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
  const left = countToolCallsLeft(transcript);
  if (left === 0) {
    return `Lookups left: 0. Reply now with ${fieldLine(AgentField.Action, `${A.Answer}, ${A.Question} or ${A.Edit}`)}.`;
  }
  return `Lookups left: ${String(left)}`;
}

function numberLines(document: DocumentSnapshot): string {
  return document.lines.map((line, index) => numberLine(index + 1, line)).join(LINE_BREAK);
}

function attachedBlocks(request: AgentRequest): PromptBlock[] {
  switch (request.kind) {
    case 'user':
      return [];
    case 'compile-fix':
      return [{ label: `${COMPILE_RESULT_LABEL}:`, text: diagnosticsText(request.diagnostics) }];
  }
}

function turnBlock(position: number, turn: AgentTurn): PromptBlock {
  switch (turn.kind) {
    case 'tool':
      return {
        label: `Result ${String(position)} (${describeCall(turn.call)}):`,
        text: renderRecord(recordToolTurn(turn)),
      };
    case 'mistake':
      return {
        label: `Result ${String(position)} (${describeDecision(turn.decision)}, ${REJECTED}):`,
        text: turn.problem,
      };
  }
}

function describeDecision(decision: AgentDecision): string {
  if (decision.kind === 'tool') return describeCall(decision.call);
  const { reply } = decision;
  return reply.kind === 'edit' ? `${A.Edit} ${reply.path}` : reply.kind;
}

function describeCall(call: ToolCall): string {
  switch (call.tool) {
    case AgentTool.ReadFile:
      if (call.range === undefined) return `${call.tool} ${call.path}`;
      return `${call.tool} ${call.path} from line ${String(call.range.startLine)}${call.range.endLine === undefined ? '' : ` to ${String(call.range.endLine)}`}`;
    case AgentTool.Search:
      return `${call.tool} ${JSON.stringify(call.query)}`;
    case AgentTool.Compile:
      return call.tool;
  }
}
