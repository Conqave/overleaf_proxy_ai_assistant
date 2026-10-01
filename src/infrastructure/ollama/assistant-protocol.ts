import type { AssistantPlan } from '../../domain/assistant-plan';
import type { AssistantReply } from '../../domain/assistant-reply';
import {
  AssistantMessageKind,
  type ConversationMessage,
  type GreetingMessage,
} from '../../domain/conversation';
import { documentText, type DocumentSnapshot } from '../../domain/document';
import { DocumentOperation, type DocumentCommand } from '../../domain/document-command';
import { InvariantViolation } from '../../domain/errors';
import type { PlanningRequest, ReplyRequest } from '../../ports/assistant-port';
import { AssistantRequestTooLargeError } from '../../ports/errors';
import {
  CONTENT,
  CONTENT_MARKER,
  EDIT_COMMAND_FIELDS,
  EditField,
  fieldLine,
  fieldName,
} from './edit-reply-format';
import {
  parseAnswerResponse,
  parseEditResponse,
  parsePlanResponse,
} from './assistant-response-parser';
import { MAX_COMPLETION_TOKENS, type GenerateRequest } from './ollama-client';

export const MIN_CONTEXT_TOKENS = 16_384;
const REPLY_RESERVE_TOKENS = 2 * MAX_COMPLETION_TOKENS;
const CHARS_PER_TOKEN = 3;
const CONVERSATION_WINDOW = 12;
export const SMALL_BLOCK_SHARE = 8;
const REJECTED_REPLY_CHARS = 3_000;
const CORRECTION_RESERVE_CHARS = 4_096;
const MIN_DOCUMENT_CHARS = 1_024;
const MIN_KEPT_CHARS = 32;

export const LINE_BREAK = '\n';
const COMPACT_GAP = LINE_BREAK.repeat(2);
const COMPACT_MARKER_CHARS = compactMarker(Number.MAX_SAFE_INTEGER).length;
const MIN_COMPACT_CHARS = COMPACT_MARKER_CHARS + 2 * MIN_KEPT_CHARS;

const USER_MESSAGE_LABEL = 'User message:';
const PLANNER_REASON_LABEL = 'Planner reason:';
export const CONVERSATION_LABEL = 'Conversation so far:';
const CARET_LABEL = 'Lines around the caret:';
export const SELECTION_LABEL = 'Selected text:';
const LOGS_LABEL = 'Compile logs:';
const NUMBERED_DOCUMENT_LABEL = 'Numbered document lines:';
const DOCUMENT_LABEL = 'Document text:';

export interface ProtocolExchange<T> {
  readonly request: GenerateRequest;
  readonly retryInstruction: string;
  readonly parse: (raw: string) => T;
}

export const LANGUAGE_RULE =
  'Write every user-facing text in the language of the user message (Polish message → Polish text). Text that goes into a file keeps the language of that file unless the user asks for a translation, and names and titles the user gives are used exactly as given, untranslated ("dodaj sekcję Conclusions" → \\section{Conclusions}).';
const JSON_RULE =
  'Output exactly one JSON object and nothing else: no markdown fences, no text before or after it.';

const PLAN_SCHEMA =
  '{"intent":"summary|explain|edit","needs":["line_context","selection","logs"],"reason":"short reason"}';

const F = EditField;

export const EDIT_FORMAT = lines(
  fieldLine(F.Operation, Object.values(DocumentOperation).join('|')),
  fieldLine(F.Line, '<line number>'),
  fieldLine(F.EndLine, '<last line number; only for a replace or delete that spans several lines>'),
  fieldLine(
    F.LineText,
    '<that line copied exactly from its start; for a long line its first sentence is enough>',
  ),
  `${fieldLine(F.Reason, '<short user-facing reason>')} (optional)`,
  `${fieldLine(F.Plan, '<one short sentence about the placement>')} (optional)`,
  CONTENT_MARKER,
  `<the new LaTeX lines, exactly as they go into the document; nothing else follows ${CONTENT_MARKER}>`,
);

const PLANNING_SYSTEM = lines(
  'You are Hans, the planner of an assistant built into the Overleaf LaTeX editor.',
  'The user is always talking about the LaTeX document open in the editor. You do not see it now; the answering step always gets the whole document, plus whatever you list in "needs".',
  'Classify the request and list the extra information the answer needs.',
  JSON_RULE,
  `Shape: ${PLAN_SCHEMA}`,
  'Intents:',
  '- summary: what the document is about, an overview or summary of it.',
  '- explain: questions, explanations and error analysis that do not change the document.',
  '- edit: add, insert, delete, remove, replace, move, fix, rewrite, translate or reformat document content (e.g. "wstaw sekcję", "dodaj tabelę", "usuń akapit", "popraw podpis", "przetłumacz").',
  'Needs (optional, often empty):',
  '- line_context: lines around the caret, when the user says "here", "this line" or similar.',
  '- selection: the selected text, when the user refers to "the selection", "zaznaczony", "this text".',
  '- logs: compile logs, for compile errors and warnings.',
  'Always choose one of the three intents; the next step sees the document and asks the user if something is unclear. "needs" and "reason" may be omitted.',
  'Example: {"intent":"edit","needs":[],"reason":"The user wants a new section."}',
);

const ANSWER_SYSTEM = lines(
  'You are Hans, an assistant built into the Overleaf LaTeX editor.',
  'Answer the user from the evidence provided. Be direct and concise; do not mention internal planning.',
  LANGUAGE_RULE,
  'Reply with the answer as plain text (no JSON). Quote LaTeX code exactly as it appears in the document.',
  'Base the answer on the document; do not invent content it does not have.',
);

export const EDIT_RULES = lines(
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

const EDIT_SYSTEM = lines(
  'You are Hans, an assistant built into the Overleaf LaTeX editor. You propose exactly one change to the document: an insertion around a line, or a replacement or deletion of one line or a range of consecutive lines.',
  LANGUAGE_RULE,
  'Reply in exactly this format, nothing before or after it (no JSON, no markdown fences):',
  EDIT_FORMAT,
  'If the location or the wanted change is unclear, reply with a single line instead:',
  fieldLine(F.Question, '<one short question>'),
  EDIT_RULES,
  'Example of an insertion:',
  fieldLine(F.Operation, DocumentOperation.InsertAfter),
  fieldLine(F.Line, '42'),
  fieldLine(F.LineText, '\\end{table}'),
  fieldLine(F.Reason, 'Dodaję tabelę z wynikami pomiarów.'),
  fieldLine(F.Plan, 'Nowa tabela zaraz po istniejącej tabeli.'),
  CONTENT_MARKER,
  '\\begin{table}',
  '\\centering',
  '\\begin{tabular}{l|r}',
  'Pomiar & Wynik \\\\\\hline',
  'A & 1.5 \\\\',
  'B & 2.0',
  '\\end{tabular}',
  '\\caption{\\label{tab:wyniki}Wyniki pomiarów.}',
  '\\end{table}',
  'Example of a replacement:',
  fieldLine(F.Operation, DocumentOperation.Replace),
  fieldLine(F.Line, '16'),
  fieldLine(F.LineText, '\\title{Your Paper}'),
  fieldLine(F.Reason, 'Zmieniam tytuł.'),
  fieldLine(F.Plan, 'Podmiana linii z tytułem.'),
  CONTENT_MARKER,
  '\\title{Raport z laboratorium}',
  'Example of a deletion of a whole subsection (heading, blank line and paragraph):',
  fieldLine(F.Operation, DocumentOperation.Delete),
  fieldLine(F.Line, '64'),
  fieldLine(F.EndLine, '67'),
  fieldLine(F.LineText, '\\subsection{Wyniki pomocnicze}'),
  fieldLine(F.Reason, 'Usuwam podsekcję z wynikami pomocniczymi.'),
  fieldLine(F.Plan, 'Usunięcie nagłówka i treści podsekcji.'),
);

const PLAN_RETRY = 'Reply again with one JSON object only, exactly matching the required shape.';
const ANSWER_RETRY = 'Reply again with the answer as plain text.';
const EDIT_RETRY = `Reply again in exactly the required format: the header lines (${EDIT_COMMAND_FIELDS.map(fieldName).join(', ')}) and ${CONTENT_MARKER}, or a single ${fieldName(F.Question)} line. No JSON.`;

export function getPromptBudget(contextTokens: number): number {
  return (contextTokens - REPLY_RESERVE_TOKENS) * CHARS_PER_TOKEN - CORRECTION_RESERVE_CHARS;
}

export function estimatePromptTokens(request: GenerateRequest): number {
  return Math.ceil((request.system.length + request.prompt.length) / CHARS_PER_TOKEN);
}

export function createPlanExchange(
  request: PlanningRequest,
  budget: number,
): ProtocolExchange<AssistantPlan> {
  const message = userMessage(request.message);
  const conversationBudget = budget - PLANNING_SYSTEM.length - message.length - LINE_BREAK.length;
  if (conversationBudget < minBlockChars(CONVERSATION_LABEL)) throw createTooLargeError();
  return {
    request: {
      system: PLANNING_SYSTEM,
      prompt: lines(message, ...conversationBlock(request.conversation, conversationBudget)),
    },
    retryInstruction: PLAN_RETRY,
    parse: parsePlanResponse,
  };
}

export function createReplyExchange(
  request: ReplyRequest,
  budget: number,
): ProtocolExchange<AssistantReply> {
  const edit = request.plan.intent === 'edit';
  const system = edit ? EDIT_SYSTEM : ANSWER_SYSTEM;
  const prompt = buildReplyPrompt(request, edit, budget - system.length);
  if (edit) {
    return {
      request: { system, prompt },
      retryInstruction: EDIT_RETRY,
      parse: (raw) => parseEditResponse(raw, request.evidence.document),
    };
  }
  return {
    request: { system, prompt },
    retryInstruction: ANSWER_RETRY,
    parse: (raw) => ({ kind: 'answer', text: parseAnswerResponse(raw) }),
  };
}

export function createCorrectionRequest(
  exchange: ProtocolExchange<unknown>,
  rejected: string,
  problem: string,
): GenerateRequest {
  return {
    system: exchange.request.system,
    prompt: lines(
      exchange.request.prompt,
      `Your previous reply was:${LINE_BREAK}${compact(rejected, REJECTED_REPLY_CHARS)}`,
      `It was rejected because: ${problem}.`,
      exchange.retryInstruction,
    ),
  };
}

function buildReplyPrompt(request: ReplyRequest, numbered: boolean, budget: number): string {
  const { evidence, plan } = request;
  const smallBlock = Math.floor(budget / SMALL_BLOCK_SHARE);
  const before = [
    userMessage(request.message),
    ...optionalBlock(PLANNER_REASON_LABEL, plan.reason, smallBlock),
    ...conversationBlock(request.conversation, smallBlock),
  ];
  const after = [
    ...optionalBlock(
      CARET_LABEL,
      evidence.lineContext === undefined ? undefined : caretLines(evidence.lineContext),
      smallBlock,
    ),
    ...optionalBlock(SELECTION_LABEL, evidence.selection, smallBlock),
    ...optionalBlock(LOGS_LABEL, evidence.logs, smallBlock),
  ];
  const documentBudget = budget - lines(...before, ...after).length - LINE_BREAK.length;
  if (documentBudget < MIN_DOCUMENT_CHARS) throw createTooLargeError();
  return lines(...before, documentBlock(evidence.document, numbered, documentBudget), ...after);
}

export function userMessage(message: string): string {
  return `${USER_MESSAGE_LABEL}${LINE_BREAK}${message}`;
}

export function conversationBlock(
  conversation: readonly ConversationMessage[],
  maxChars: number,
): string[] {
  const recent = conversation.filter(isTranscribed).slice(-CONVERSATION_WINDOW);
  if (!recent.length) return [];
  const text = recent
    .map((message) => `[${message.role}] ${transcriptText(message)}`)
    .join(LINE_BREAK);
  return [block(CONVERSATION_LABEL, text, maxChars)];
}

function isTranscribed(
  message: ConversationMessage,
): message is Exclude<ConversationMessage, GreetingMessage> {
  return message.role === 'user' || message.kind !== AssistantMessageKind.Greeting;
}

function transcriptText(message: Exclude<ConversationMessage, GreetingMessage>): string {
  if (message.role === 'user' || message.kind !== AssistantMessageKind.Proposal) {
    return message.text.trim();
  }
  return describeProposal(message.command);
}

function describeProposal(command: DocumentCommand): string {
  const proposed = `Proposed ${command.operation} at line ${String(command.target.lineNumber)}`;
  const summary = command.reason === undefined ? proposed : `${proposed}: ${command.reason}`;
  switch (command.operation) {
    case DocumentOperation.InsertBefore:
    case DocumentOperation.InsertAfter:
    case DocumentOperation.Replace:
      return `${summary}\n${command.content}`;
    case DocumentOperation.Delete:
      return summary;
  }
}

function caretLines(context: NonNullable<ReplyRequest['evidence']['lineContext']>): string {
  return context.lines
    .map((text, i) => `${String(context.firstLineNumber + i)}: ${text}`)
    .join(LINE_BREAK);
}

function documentBlock(snapshot: DocumentSnapshot, numbered: boolean, maxChars: number): string {
  if (!numbered) return block(DOCUMENT_LABEL, documentText(snapshot), maxChars);
  const text = snapshot.lines.map((line, index) => `${String(index + 1)}: ${line}`);
  return block(NUMBERED_DOCUMENT_LABEL, text.join(LINE_BREAK), maxChars);
}

function optionalBlock(label: string, text: string | undefined, maxChars: number): string[] {
  return text === undefined ? [] : [block(label, text, maxChars)];
}

export function block(label: string, text: string, maxChars: number): string {
  const heading = blockHeading(label);
  return `${heading}${compact(text, maxChars - heading.length)}`;
}

export function blockHeading(label: string): string {
  return `${LINE_BREAK}${label}${LINE_BREAK}`;
}

export function minBlockChars(label: string): number {
  return blockHeading(label).length + MIN_COMPACT_CHARS;
}

export function compact(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars < MIN_COMPACT_CHARS) {
    throw new InvariantViolation(`cannot compact text into ${String(maxChars)} characters`);
  }
  const keep = Math.floor((maxChars - COMPACT_MARKER_CHARS) / 2);
  const omitted = text.length - 2 * keep;
  return `${text.slice(0, keep)}${compactMarker(omitted)}${text.slice(-keep)}`;
}

function compactMarker(omitted: number): string {
  return `${COMPACT_GAP}[AUTOCOMPACTED: omitted ${String(omitted)} chars]${COMPACT_GAP}`;
}

export function createTooLargeError(): AssistantRequestTooLargeError {
  return new AssistantRequestTooLargeError(
    "The message is too long for the model's context window; shorten it and try again.",
  );
}

export function lines(...parts: readonly string[]): string {
  return parts.join(LINE_BREAK);
}
