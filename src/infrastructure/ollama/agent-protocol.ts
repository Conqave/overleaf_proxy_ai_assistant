import { AgentTool, type AgentDecision, type ToolCall } from '../../domain/agent-action';
import { countToolCallsLeft } from '../../domain/agent-policy';
import type { AgentTurn, CompileDiagnostic, ToolResult } from '../../domain/agent-transcript';
import type { DocumentSnapshot } from '../../domain/document';
import { DocumentOperation } from '../../domain/document-command';
import { ProjectFileKind, type ProjectFile } from '../../domain/project-file';
import type { AgentStepRequest } from '../../ports/agent-port';
import { createTooLargeError, PROMPT_BUDGET_CHARS } from './context-budget';
import { getCorrectionReserveChars, type ProtocolExchange } from './correction-exchange';
import { parseAgentDecision } from './reply-parser';
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
  conversationBlock,
  CONVERSATION_LABEL,
  LINE_BREAK,
  lines,
  minBlockChars,
  SELECTION_LABEL,
  SMALL_BLOCK_SHARE,
  userMessage,
} from './prompt-blocks';

const OPEN_FILE_SHARE = 2;

const FILES_LABEL = 'Project files:';
const SMALL_BLOCK_LABELS: readonly string[] = [FILES_LABEL, CONVERSATION_LABEL, SELECTION_LABEL];
const NO_PROBLEMS = '(no problems)';
const NO_MATCHES = '(no matches)';
const MORE_MATCHES = '(more matches omitted; search for something more specific)';
const REJECTED = 'rejected';

const A = AgentAction;
const F = EditField;

const LANGUAGE_RULE =
  'Write every user-facing text in the language of the user message (Polish message → Polish text). Text that goes into a file keeps the language of that file unless the user asks for a translation, and names and titles the user gives are used exactly as given, untranslated ("dodaj sekcję Conclusions" → \\section{Conclusions}).';

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
  `- Everything after ${CONTENT_MARKER} is inserted verbatim: plain LaTeX source, one source line per line, no escaping, no fences.`,
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
  fieldLine(AgentField.Question, '<one short question>'),
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
  `- When the user says the project does not compile or reports errors or warnings, your first action is ${A.Compile}, before any ${A.ReadFile}; then read the file it names and fix the first error it reports; the errors after it are often only its consequences, so change nothing else.`,
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

export const AGENT_PROMPT_BUDGET = PROMPT_BUDGET_CHARS - getCorrectionReserveChars(RETRY);

export function createAgentExchange(
  request: AgentStepRequest,
  budget: number,
): ProtocolExchange<AgentDecision> {
  return {
    request: { system: AGENT_SYSTEM, prompt: buildPrompt(request, budget - AGENT_SYSTEM.length) },
    retryInstruction: RETRY,
    parse: parseAgentDecision,
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
  const results = transcript.map((turn, index) => turnBlock(index + 1, turn));
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
  const left = countToolCallsLeft(transcript);
  if (left === 0) {
    return `Lookups left: 0. Reply now with ${fieldLine(AgentField.Action, `${A.Answer}, ${A.Question} or ${A.Edit}`)}.`;
  }
  return `Lookups left: ${String(left)}`;
}

function numberLines(document: DocumentSnapshot): string {
  return document.lines.map((line, index) => `${String(index + 1)}: ${line}`).join(LINE_BREAK);
}

function turnBlock(position: number, turn: AgentTurn): PromptBlock {
  switch (turn.kind) {
    case 'tool':
      return {
        label: `Result ${String(position)} (${describeCall(turn.call)}):`,
        text: resultText(turn.result),
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
