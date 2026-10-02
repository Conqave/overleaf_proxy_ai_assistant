import { AgentTool, type AgentDecision, type ToolCall } from '../../domain/agent-action';
import {
  AGENT_POLICY,
  AgentRole,
  countToolCallsLeft,
  MAIN_AGENT_POLICY,
  SUBAGENT_POLICY,
  type AgentPolicy,
} from '../../domain/agent-policy';
import {
  findUncheckedFiles,
  recordToolTurn,
  type AgentTurn,
  type ToolRecord,
} from '../../domain/agent-transcript';
import type { ConversationView } from '../../domain/conversation-view';
import type { DocumentSnapshot } from '../../domain/document';
import { DocumentOperation } from '../../domain/document-command';
import { ProjectFileKind, type ProjectFile } from '../../domain/project-file';
import { InvariantViolation } from '../../domain/errors';
import { numberLine, READ_LIMITS } from '../../domain/read-window';
import { getRequestPolicy, type AgentRequest, type AgentStepRequest } from '../../ports/agent-port';
import {
  createMessageTooLargeError,
  CURRENT_RESULT_SHARE,
  ESTIMATED_PROMPT_CHARS,
} from './context-budget';
import { HARMONY_FRAMING_CHARS } from './harmony-format';
import { getCorrectionReserveChars, type ProtocolExchange } from './correction-exchange';
import { parseAgentDecision } from './reply-parser';
import { describeSearch, diagnosticsText, renderShortRecord } from './tool-record-text';
import { conversationText, getViewRecords } from './conversation-text';
import { findOutdatedReads, renderUnlessOutdated } from './outdated-reads';
import {
  AgentAction,
  AgentField,
  CONTENT,
  CONTENT_MARKER,
  EditField,
  fieldLine,
  FILE_SEPARATOR,
  TEXT_MARKER,
} from './reply-format';
import {
  block,
  blockHeading,
  compact,
  CONVERSATION_LABEL,
  LINE_BREAK,
  lines,
  MIN_COMPACT_CHARS,
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
const CURRENT_RESULT_SHORTENED =
  'look up a smaller part (START_LINE and END_LINE, or a narrower search) to see the rest';
const COMPILE_RESULT_LABEL = 'Compile result after the applied change';

const A = AgentAction;
const F = EditField;

const LANGUAGE_RULE = `Write every user-facing text in the language of the user's latest message: the User message, or for a System request the user's last message shown with it (Polish message → Polish text). Text that goes into a file keeps the language of that file unless the user asks to translate it, and a translation of file text is an edit that replaces that text in its file; names and titles the user gives are used exactly as given, untranslated ("dodaj sekcję Conclusions" → \\section{Conclusions}).`;

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
  'Several changes:',
  `- Use one block per place: a request that touches several places, such as renaming a \\label together with every \\ref to it, gets all its blocks in one ${A.Edit} reply.`,
  `- ${F.Line} and ${F.EndLine} in every block are the line numbers as shown to you; the editor applies the blocks bottom-up, so earlier blocks never shift the lines of later ones.`,
  `- Two blocks never change the same line or the same place; join neighbouring changes into one ${DocumentOperation.Replace} with ${F.Line} and ${F.EndLine}.`,
);

const actionLine = (action: AgentAction): string => fieldLine(AgentField.Action, action);

const replyFormat = (policy: AgentPolicy): readonly string[] => [
  `Every reply is exactly one action written as plain text lines in the reply itself. The first line is always ${fieldLine(AgentField.Action, '<action>')}. No JSON, no markdown fences, nothing before or after.`,
  `You have no functions and no tools to call. Never send a message to a recipient or a function: the whole reply goes to the final channel as plain text, including ${listItems(policy.tools, 'and')}, which are only lines of text that the editor reads.`,
];

const LOOKUP_INTRO =
  'Lookups collect information you do not have yet. A lookup is your final answer for this turn: write its lines as the final answer and stop. The editor then performs it and asks you again with its outcome added as "Result N".';

const READ_FILE_LOOKUP: readonly string[] = [
  `- ${A.ReadFile}: shows the numbered lines of one text file of the project, at most ${String(READ_LIMITS.maxLines)} lines or ${String(READ_LIMITS.maxChars)} characters at a time. For a long file add ${AgentField.StartLine} and ${EditField.EndLine} (line numbers, both optional) to read another part.`,
  actionLine(A.ReadFile),
  fieldLine(AgentField.Path, 'sample.bib'),
];

const SEARCH_LOOKUP: readonly string[] = [
  `- ${A.Search}: finds a text in every text file of the project, case-insensitively, and lists each matching line as path:line: text. Use it to find where a \\label, \\cite key, \\ref, command or phrase is.`,
  actionLine(A.Search),
  fieldLine(AgentField.Query, '\\label{fig:frog}'),
];

const SCOPED_SEARCH_LOOKUP: readonly string[] = [
  `- ${A.Search}: finds a text in the text files of the project, case-insensitively, and lists each matching line as path:line: text, at most ${String(AGENT_POLICY.maxSearchMatches)} lines. Use it to find where a \\label, \\cite key, \\ref, command or phrase is. Without ${AgentField.Path} it searches the whole project; with ${AgentField.Path} set to one file or one folder exactly as listed under Project files it searches only there.`,
  actionLine(A.Search),
  fieldLine(AgentField.Query, '\\cite{'),
  fieldLine(AgentField.Path, 'chapters/intro.tex'),
];

const DELEGATE_LOOKUP: readonly string[] = [
  `- ${A.Delegate}: hands a research task to a helper that starts with an empty context of its own, does its own ${A.ReadFile} and ${A.Search} lookups, cannot edit, and returns only its short findings as the result of this lookup. Use it when the request needs many files read or many places checked across the project (every \\cite key against the .bib files, all tables of several chapters) and only the findings matter, so that the full text of those files stays out of your context; never for a single file or a single ${A.Search}. At most ${String(AGENT_POLICY.maxDelegations)} per request. ${AgentField.Task} is one line that says everything the helper needs: what to check and what to report, with path:line; ${AgentField.Files} (optional) lists the paths to start with, separated by "${FILE_SEPARATOR}".`,
  actionLine(A.Delegate),
  fieldLine(
    AgentField.Task,
    'List every table in chapters/ch2.tex, chapters/ch3.tex and chapters/ch4.tex that has no \\caption, with path:line of its \\begin{table}.',
  ),
  fieldLine(AgentField.Files, 'chapters/ch2.tex, chapters/ch3.tex, chapters/ch4.tex'),
];

const partialReadRule = (before: string): string =>
  `- A result "Showing only lines A–B of N" shows only part of the file; lines up to N exist. Read the part you need with ${AgentField.StartLine} and ${EditField.EndLine}, or ${A.Search} for it, before you ${before}.`;

const STEP_RULES: readonly string[] = [
  '- Never repeat a lookup; use the result you already have.',
  `- A result marked ${REJECTED} explains why your action at that step was not carried out; send a corrected action instead of repeating it.`,
];

const lookupsLeftRule = (policy: AgentPolicy): string =>
  `- When "Lookups left" is 0, reply now with ${listItems(policy.replies, 'or')}.`;

function listItems(items: readonly string[], conjunction: 'and' | 'or'): string {
  const last = items.at(-1);
  if (last === undefined) throw new InvariantViolation('a policy lists at least one action');
  const others = items.slice(0, -1);
  return others.length ? `${others.join(', ')} ${conjunction} ${last}` : last;
}

const AGENT_SYSTEM = lines(
  'You are Hans, an assistant built into the Overleaf LaTeX editor. You help with the whole LaTeX project: all files under "Project files"; one of them is open in the editor and shown to you with numbered lines.',
  LANGUAGE_RULE,
  ...replyFormat(MAIN_AGENT_POLICY),
  '',
  LOOKUP_INTRO,
  ...READ_FILE_LOOKUP,
  ...SEARCH_LOOKUP,
  `- ${A.Compile}: compiles the project and lists its errors and warnings. Use it only when the request is about compile errors, warnings or a broken build.`,
  actionLine(A.Compile),
  ...DELEGATE_LOOKUP,
  '',
  'Replies end the request.',
  `- ${A.Answer}: an explanation, summary or answer; the text after ${TEXT_MARKER} may span several lines and may use Markdown (headings, lists, **bold**, \`inline code\`, tables, and fenced code blocks for LaTeX snippets).`,
  actionLine(A.Answer),
  TEXT_MARKER,
  '<the answer>',
  `- ${A.Question}: only when you cannot act at all. Details the user leaves open, such as the exact wording or an example sentence, you write yourself and still reply with ${A.Edit}.`,
  actionLine(A.Question),
  fieldLine(AgentField.Question, '<one short question>'),
  `- ${A.Edit}: one or more changes, each an insertion around a line or a replacement or deletion of one line or a range of consecutive lines, in one file or in several files. Every request to add, change, remove, fix, rewrite or translate content of a file ends with an ${A.Edit} that the user reviews and applies, never with the new text in an ${A.Answer}; translating the selected text means replacing it in its file. Each change is one block that starts with its ${AgentField.Path} line:`,
  actionLine(A.Edit),
  fieldLine(AgentField.Path, '<file path exactly as listed under Project files>'),
  EDIT_FORMAT,
  `For several changes (several places or several files), repeat the block from ${AgentField.Path} to its content once per change, at most ${String(AGENT_POLICY.maxEditsPerChange)} blocks in one reply; every block starts with its own ${AgentField.Path} line, also for another place in the same file, and the content of a block ends where the next ${AgentField.Path} line starts.`,
  '',
  'How to work:',
  '- The open file is already shown with numbered lines: never read it; answer or edit it directly.',
  `- Any other file must be read with ${A.ReadFile} before you edit it or quote it; you can only edit lines that were shown to you. A ${A.Search} result shows single matching lines and does not count as reading them: read the lines around a match before you edit them.`,
  `- ${AgentField.Path} is always a path exactly as listed under Project files; files marked (binary) cannot be read or edited. If a file the user names is not listed, say so in an ${A.Answer}.`,
  partialReadRule('answer or edit'),
  `- Use ${A.Search} to find labels, citations, commands or text when you do not know which file has them.`,
  `- When a ${A.Search} result says that more matches were omitted and the request needs all of them (every \\cite, every table, every label across the chapters), ${A.Delegate} the check instead of searching again.`,
  `- A ${A.Delegate} result holds only the helper's findings: answer from it, and read the lines you change with ${A.ReadFile} before an ${A.Edit}.`,
  `- When the user says the project does not compile or reports errors or warnings, your first action is ${A.Compile}, before any ${A.ReadFile}: you cannot compile in your head, and only its result shows the real errors and where they are; then read the file it names and fix the first error it reports; the errors after it are often only its consequences, so the fix is an ${A.Edit} with a single block and changes nothing else.`,
  `- A System request about compile errors comes with "${COMPILE_RESULT_LABEL}": do not ${A.Compile} again; read the file it names and fix only the first error it reports, with a single block.`,
  `- Verbs such as translate, fix, change, add, remove, rewrite (przetłumacz, popraw, zmień, dodaj, usuń, przepisz) applied to text of a file, including the selected text, ask for an ${A.Edit} of that file even when the user does not name the file; the new text never goes into an ${A.Answer}.`,
  `- Verbs such as explain, describe, summarize (wyjaśnij, opisz, streść) ask for an ${A.Answer}; they never change a file.`,
  '- Reply as soon as you know enough.',
  ...STEP_RULES,
  lookupsLeftRule(MAIN_AGENT_POLICY),
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
  'Example of one edit with two changes in two files (renaming a label and its reference, both files read before):',
  actionLine(A.Edit),
  fieldLine(AgentField.Path, 'chapters/results.tex'),
  fieldLine(F.Operation, DocumentOperation.Replace),
  fieldLine(F.Line, '2'),
  fieldLine(F.LineText, '\\label{sec:results}'),
  fieldLine(F.Reason, 'Zmieniam etykietę sekcji.'),
  CONTENT_MARKER,
  '\\label{sec:measurements}',
  fieldLine(AgentField.Path, 'main.tex'),
  fieldLine(F.Operation, DocumentOperation.Replace),
  fieldLine(F.Line, '41'),
  fieldLine(F.LineText, 'Wyniki są w rozdziale~\\ref{sec:results}.'),
  fieldLine(F.Reason, 'Aktualizuję odwołanie do etykiety.'),
  CONTENT_MARKER,
  'Wyniki są w rozdziale~\\ref{sec:measurements}.',
  'Example of a deletion of a whole subsection (heading, blank line and paragraph):',
  actionLine(A.Edit),
  fieldLine(AgentField.Path, 'main.tex'),
  fieldLine(F.Operation, DocumentOperation.Delete),
  fieldLine(F.Line, '30'),
  fieldLine(F.EndLine, '33'),
  fieldLine(F.LineText, '\\subsection{Wyniki pomocnicze}'),
  fieldLine(F.Reason, 'Usuwam podsekcję z wynikami pomocniczymi.'),
);

const SUBAGENT_SYSTEM = lines(
  'You are a research helper of Hans, an assistant built into the Overleaf LaTeX editor. Hans hands you one task about the LaTeX project. You start with an empty context: you see only the task, the list of project files and the results of your own lookups. You cannot edit, compile, ask questions or hand the task on.',
  ...replyFormat(SUBAGENT_POLICY),
  '',
  LOOKUP_INTRO,
  ...READ_FILE_LOOKUP,
  ...SCOPED_SEARCH_LOOKUP,
  '',
  'The reply ends the task.',
  `- ${A.Answer}: your findings for Hans in at most ${String(AGENT_POLICY.maxDelegationResultChars)} characters: only the facts the task asks for, each with its path:line, without introduction or advice. When nothing matches, say so; when you could not check everything, say what is left unchecked.`,
  actionLine(A.Answer),
  TEXT_MARKER,
  '<the findings>',
  '',
  'How to work:',
  `- Start with the files the task names. Use ${A.Search} to find commands, \\cite keys, labels or text across the files, and ${A.ReadFile} to check them in context.`,
  `- Every reply is one lookup: one ${A.ReadFile} with one ${AgentField.Path}, or one ${A.Search} with one ${AgentField.Query}. To read or search several files, take them one after another, one file per reply.`,
  `- When a ${A.Search} result says that more matches were omitted, search each file the task names on its own with ${AgentField.Path}, or ${A.ReadFile} it, instead of repeating the search.`,
  `- ${AgentField.Path} is always a path exactly as listed under Project files; files marked (binary) cannot be read.`,
  partialReadRule('reply'),
  '- Check every file and every item the task covers before you reply: findings that leave a file out are wrong. Reply as soon as everything is checked.',
  '- When the task compares items, such as \\cite keys against .bib entries, go through the results item by item before you reply: take each item, look it up in the other result, and note every one that does not match.',
  ...STEP_RULES,
  lookupsLeftRule(SUBAGENT_POLICY),
  '- Base the findings on the files only; quote LaTeX exactly. Write them in English.',
  '',
  'Example of a lookup:',
  actionLine(A.Search),
  fieldLine(AgentField.Query, '\\cite{'),
  'Example of findings:',
  actionLine(A.Answer),
  TEXT_MARKER,
  '- chapters/intro.tex:12 \\cite{smith20}: key defined in refs.bib:3',
  '- chapters/intro.tex:30 \\cite{doe19}: key missing from every .bib file',
);

interface RoleProtocol {
  readonly policy: AgentPolicy;
  readonly system: string;
  readonly retry: string;
  readonly correctionReserveChars: number;
}

function createRoleProtocol(policy: AgentPolicy, system: string): RoleProtocol {
  const actions = [...policy.tools, ...policy.replies].join('|');
  const retry = `Reply again with exactly one action: the first line ${fieldLine(AgentField.Action, actions)}, then only the lines that action takes. No JSON.`;
  return { policy, system, retry, correctionReserveChars: getCorrectionReserveChars(retry) };
}

const ROLE_PROTOCOLS: Readonly<Record<AgentRole, RoleProtocol>> = {
  [AgentRole.Main]: createRoleProtocol(MAIN_AGENT_POLICY, AGENT_SYSTEM),
  [AgentRole.Subagent]: createRoleProtocol(SUBAGENT_POLICY, SUBAGENT_SYSTEM),
};

function getRoleProtocol(request: AgentStepRequest): RoleProtocol {
  return ROLE_PROTOCOLS[getRequestPolicy(request.request).role];
}

export function createAgentExchange(
  request: AgentStepRequest,
  promptChars: number,
): ProtocolExchange<AgentDecision> {
  const protocol = getRoleProtocol(request);
  return {
    request: {
      system: protocol.system,
      prompt: buildPrompt(request, getPromptBudget(protocol, promptChars)),
    },
    retryInstruction: protocol.retry,
    parse: parseAgentDecision,
  };
}

interface PromptBlock {
  readonly label: string;
  readonly text: string;
}

interface RenderedBlocks {
  readonly history: readonly string[];
  readonly open: readonly string[];
  readonly results: readonly string[];
}

interface ComposedPrompt {
  readonly requested: string;
  readonly history: readonly PromptBlock[];
  readonly files: PromptBlock;
  readonly open: PromptBlock | null;
  readonly results: readonly PromptBlock[];
  readonly selection: readonly PromptBlock[];
  readonly toolsLeft: string;
}

export function measureAgentPromptChars(request: AgentStepRequest): number {
  const protocol = getRoleProtocol(request);
  const composed = composePrompt(request, getPromptBudget(protocol, ESTIMATED_PROMPT_CHARS));
  const blocks = [
    ...composed.history,
    composed.files,
    ...optionalBlock(composed.open),
    ...composed.results,
  ];
  const separators = (blocks.length + composed.selection.length + 1) * LINE_BREAK.length;
  return (
    HARMONY_FRAMING_CHARS +
    protocol.system.length +
    composed.requested.length +
    sum([...blocks, ...composed.selection].map(fullSize)) +
    `${LINE_BREAK}${composed.toolsLeft}`.length +
    separators
  );
}

export function measureConversationChars(conversation: ConversationView): number {
  const history = historyBlock(conversation, findOutdatedReads(getViewRecords(conversation)));
  return sum(history.map(fullSize));
}

function getPromptBudget(protocol: RoleProtocol, promptChars: number): number {
  return promptChars - protocol.correctionReserveChars - protocol.system.length;
}

function optionalBlock(promptBlock: PromptBlock | null): readonly PromptBlock[] {
  return promptBlock === null ? [] : [promptBlock];
}

function composePrompt(request: AgentStepRequest, budget: number): ComposedPrompt {
  const { workspace, transcript } = request;
  const policy = getRequestPolicy(request.request);
  const isMain = policy.role === AgentRole.Main;
  const records = transcript.map((turn) => (turn.kind === 'tool' ? recordToolTurn(turn) : null));
  const outdated = findOutdatedReads([
    ...getViewRecords(request.conversation),
    ...records.filter((record) => record !== null),
  ]);
  const resultChars = Math.max(MIN_COMPACT_CHARS, Math.floor(budget / CURRENT_RESULT_SHARE));
  return {
    requested: requestBlock(request.request, request.conversation),
    history: historyBlock(request.conversation, outdated),
    files: {
      label: FILES_LABEL,
      text: fileList(workspace.files, isMain ? workspace.openFile.path : null),
    },
    open: isMain
      ? {
          label: `Numbered lines of ${workspace.openFile.path} (open in the editor, caret on line ${String(workspace.cursorLine)}):`,
          text: numberLines(workspace.openFile.document),
        }
      : null,
    results: [
      ...attachedBlocks(request.request, resultChars),
      ...transcript.map((turn, index) =>
        turnBlock(index + 1, turn, { record: itemAt(records, index), outdated, resultChars }),
      ),
    ],
    selection:
      !isMain || workspace.selection === ''
        ? []
        : [{ label: SELECTION_LABEL, text: workspace.selection }],
    toolsLeft: toolsLeft(request.request, transcript),
  };
}

function buildPrompt(request: AgentStepRequest, budget: number): string {
  const smallBlock = Math.floor(
    (budget - requestBlock(request.request, request.conversation).length) / SMALL_BLOCK_SHARE,
  );
  if (SMALL_BLOCK_LABELS.some((label) => smallBlock < minBlockChars(label))) {
    throw createMessageTooLargeError();
  }
  const composed = composePrompt(request, budget);
  const { requested, history, open, results } = composed;
  const files = block(composed.files.label, composed.files.text, smallBlock);
  const after = [
    ...composed.selection.map((selected) => block(selected.label, selected.text, smallBlock)),
    `${LINE_BREAK}${composed.toolsLeft}`,
  ];
  const separators =
    (history.length + optionalBlock(open).length + results.length + 1) * LINE_BREAK.length;
  const available = budget - lines(requested, files, ...after).length - separators;
  const rendered = renderBlocks(available, history, open, results);
  return lines(
    requested,
    ...rendered.history,
    files,
    ...rendered.open,
    ...rendered.results,
    ...after,
  );
}

function historyBlock(
  conversation: ConversationView,
  outdated: ReadonlySet<ToolRecord>,
): PromptBlock[] {
  if (conversation.summary === null && !conversation.messages.length) return [];
  return [{ label: CONVERSATION_LABEL, text: conversationText(conversation, outdated) }];
}

function renderBlocks(
  available: number,
  history: readonly PromptBlock[],
  open: PromptBlock | null,
  results: readonly PromptBlock[],
): RenderedBlocks {
  const others = sum([...optionalBlock(open), ...results].map(fullSize));
  const historyShares = history.map((past) =>
    Math.max(
      floorSize(past),
      Math.min(fullSize(past), Math.max(available - others, Math.floor(available / HISTORY_SHARE))),
    ),
  );
  const current = renderCurrentBlocks(available - sum(historyShares), open, results);
  return {
    history: history.map((past, index) =>
      block(past.label, past.text, itemAt(historyShares, index)),
    ),
    ...current,
  };
}

function renderCurrentBlocks(
  available: number,
  open: PromptBlock | null,
  results: readonly PromptBlock[],
): Omit<RenderedBlocks, 'history'> {
  const resultFloors = sum(results.map(floorSize));
  const openFloor = open === null ? 0 : floorSize(open);
  if (available < openFloor + resultFloors) throw createMessageTooLargeError();
  const openShare =
    open === null
      ? 0
      : Math.max(
          openFloor,
          Math.min(
            fullSize(open),
            Math.max(
              Math.floor(available / OPEN_FILE_SHARE),
              available - sum(results.map(fullSize)),
            ),
            available - resultFloors,
          ),
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
  return {
    open: open === null ? [] : [block(open.label, open.text, openShare)],
    results: rendered,
  };
}

function itemAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new InvariantViolation(`no item ${String(index)}`);
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

function fileList(files: readonly ProjectFile[], openPath: string | null): string {
  return files.map((file) => `${file.path}${fileNote(file, openPath)}`).join(LINE_BREAK);
}

function fileNote(file: ProjectFile, openPath: string | null): string {
  if (file.kind === ProjectFileKind.Binary) return ' (binary)';
  if (file.path === openPath) return ' (open in the editor)';
  return '';
}

function toolsLeft(request: AgentRequest, transcript: readonly AgentTurn[]): string {
  const counted = countLookupsLeft(getRequestPolicy(request), transcript);
  if (request.kind !== 'subtask' || !request.files.length) return counted;
  const unchecked = findUncheckedFiles(request.files, transcript);
  const checked = unchecked.length
    ? `Files to check that are not checked yet: ${unchecked.join(', ')}`
    : 'Every file to check is checked.';
  return lines(checked, counted);
}

function countLookupsLeft(policy: AgentPolicy, transcript: readonly AgentTurn[]): string {
  const left = countToolCallsLeft(policy, transcript);
  if (left === 0) {
    return `Lookups left: 0. Reply now with ${fieldLine(AgentField.Action, listItems(policy.replies, 'or'))}.`;
  }
  return `Lookups left: ${String(left)}`;
}

function numberLines(document: DocumentSnapshot): string {
  return document.lines.map((line, index) => numberLine(index + 1, line)).join(LINE_BREAK);
}

function attachedBlocks(request: AgentRequest, resultChars: number): PromptBlock[] {
  switch (request.kind) {
    case 'user':
      return [];
    case 'compile-fix':
      return [
        {
          label: `${COMPILE_RESULT_LABEL}:`,
          text: compact(diagnosticsText(request.diagnostics), resultChars),
        },
      ];
    case 'subtask':
      return [];
  }
}

interface TurnRendering {
  readonly record: ToolRecord | null;
  readonly outdated: ReadonlySet<ToolRecord>;
  readonly resultChars: number;
}

function turnBlock(
  position: number,
  turn: AgentTurn,
  { record, outdated, resultChars }: TurnRendering,
): PromptBlock {
  switch (turn.kind) {
    case 'tool':
      if (record === null) throw new InvariantViolation('a lookup has no record');
      return {
        label: `Result ${String(position)} (${describeCall(turn.call)}):`,
        text: renderUnlessOutdated(record, outdated, (shown) =>
          renderShortRecord(shown, resultChars, CURRENT_RESULT_SHORTENED),
        ),
      };
    case 'mistake':
      return {
        label: `Result ${String(position)} (${describeDecision(turn.decision)}, ${REJECTED}):`,
        text: compact(turn.problem, resultChars),
      };
  }
}

function describeDecision(decision: AgentDecision): string {
  if (decision.kind === 'tool') return describeCall(decision.call);
  const { reply } = decision;
  if (reply.kind !== 'edit') return reply.kind;
  const paths = new Set(reply.edits.map(({ path }) => path));
  return `${A.Edit} ${[...paths].join(', ')}`;
}

function describeCall(call: ToolCall): string {
  switch (call.tool) {
    case AgentTool.ReadFile:
      if (call.range === undefined) return `${call.tool} ${call.path}`;
      return `${call.tool} ${call.path} from line ${String(call.range.startLine)}${call.range.endLine === undefined ? '' : ` to ${String(call.range.endLine)}`}`;
    case AgentTool.Search:
      return describeSearch(call.query, call.path);
    case AgentTool.Compile:
      return call.tool;
    case AgentTool.Delegate:
      return `${call.tool} ${JSON.stringify(call.task)}`;
  }
}
