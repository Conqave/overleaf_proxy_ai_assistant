import type { AssistantPlan } from '../../domain/assistant-plan';
import type { AssistantReply } from '../../domain/assistant-reply';
import type { ConversationMessage } from '../../domain/conversation';
import { documentText, type DocumentSnapshot } from '../../domain/document';
import { InvariantViolation } from '../../domain/errors';
import type { PlanningRequest, ReplyRequest } from '../../ports/assistant-port';
import { AssistantRequestTooLargeError } from '../../ports/errors';
import {
  EDIT_FIELDS,
  parseAnswerResponse,
  parseEditResponse,
  parsePlanResponse,
} from './assistant-response-parser';
import type { GenerateRequest } from './ollama-client';

export const MIN_CONTEXT_TOKENS = 16_384;
const REPLY_RESERVE_TOKENS = 8_192;
const CHARS_PER_TOKEN = 3;
const CONVERSATION_WINDOW = 12;
const SMALL_BLOCK_SHARE = 8;
const REJECTED_REPLY_CHARS = 3_000;
const CORRECTION_RESERVE_CHARS = 4_096;
const MIN_DOCUMENT_CHARS = 1_024;
const MIN_COMPACT_CHARS = 128;

export interface ProtocolExchange<T> {
  readonly request: GenerateRequest;
  readonly retryInstruction: string;
  readonly parse: (raw: string) => T;
}

const LANGUAGE_RULE =
  'Write every user-facing text in the language of the user message (Polish message → Polish text).';
const JSON_RULE =
  'Output exactly one JSON object and nothing else: no markdown fences, no text before or after it.';

const PLAN_SCHEMA =
  '{"intent":"summary|explain|edit","needs":["line_context","selection","logs"],"reason":"short reason"}';

const EDIT_FORMAT = [
  'OPERATION: insert_before|insert_after|replace|delete',
  'LINE: <line number>',
  'END_LINE: <last line number; only for a replace or delete that spans several lines>',
  'LINE_TEXT: <that line copied exactly from its start; for a long line its first sentence is enough>',
  'REASON: <short user-facing reason> (optional)',
  'PLAN: <one short sentence about the placement> (optional)',
  'CONTENT:',
  '<the new LaTeX lines, exactly as they go into the document>',
].join('\n');

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

const EDIT_SYSTEM = lines(
  'You are Hans, an assistant built into the Overleaf LaTeX editor. You propose exactly one change to the document: an insertion around a line, or a replacement or deletion of one line or a range of consecutive lines.',
  LANGUAGE_RULE,
  'Reply in exactly this format, nothing before or after it (no JSON, no markdown fences):',
  EDIT_FORMAT,
  'If the location or the wanted change is unclear, reply with a single line instead:',
  'QUESTION: <one short question>',
  'Operations — the lines are chosen from Numbered document lines:',
  '- insert_before / insert_after: CONTENT is added before / after that line.',
  '- replace: lines LINE to END_LINE (or just LINE) are swapped for CONTENT. Keep everything that should stay, e.g. the \\label inside a \\caption.',
  '- delete: lines LINE to END_LINE (or just LINE) are removed; CONTENT: is left out or left empty.',
  '- END_LINE only for replace and delete, only when the change spans several consecutive lines (a paragraph over several lines, a whole subsection with its text, an environment).',
  'Targeting:',
  '- LINE is the number of the line and LINE_TEXT its text copied exactly from the start, without the "N: " prefix; for a long paragraph the first sentence is enough.',
  '- Do not target \\begin{document}, \\maketitle, \\tableofcontents or preamble lines unless the user asks for that location.',
  '- New sections go after the end of the closest related section; with no sections yet, after \\maketitle.',
  '- Explanatory text goes before the table, figure, equation or listing it describes; captions and labels go inside their environment.',
  '- "after X" / "before X": target the line containing X. For a whole environment, target its \\end{...} line (after) or its \\begin{...} line (before).',
  '- Selected text, when given, is what the user means by "this", "zaznaczony", "the selection": change the line that contains it without asking.',
  '- When the request covers several consecutive lines, use one replace or delete with LINE and END_LINE instead of asking which line; when several places could match, choose the one most specifically about the request.',
  'Content:',
  '- Everything after CONTENT: is inserted verbatim: plain LaTeX source, one source line per line, no escaping, no fences.',
  '- It must be valid LaTeX: close every environment you open.',
  '- Only the new or changed lines; never repeat unchanged surrounding lines and never rewrite the whole document.',
  'Example of an insertion:',
  'OPERATION: insert_after',
  'LINE: 42',
  'LINE_TEXT: \\end{table}',
  'REASON: Dodaję tabelę z wynikami pomiarów.',
  'PLAN: Nowa tabela zaraz po istniejącej tabeli.',
  'CONTENT:',
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
  'OPERATION: replace',
  'LINE: 16',
  'LINE_TEXT: \\title{Your Paper}',
  'REASON: Zmieniam tytuł.',
  'PLAN: Podmiana linii z tytułem.',
  'CONTENT:',
  '\\title{Raport z laboratorium}',
  'Example of a deletion of a whole subsection (heading, blank line and paragraph):',
  'OPERATION: delete',
  'LINE: 64',
  'END_LINE: 67',
  'LINE_TEXT: \\subsection{Wyniki pomocnicze}',
  'REASON: Usuwam podsekcję z wynikami pomocniczymi.',
  'PLAN: Usunięcie nagłówka i treści podsekcji.',
);

const PLAN_RETRY = 'Reply again with one JSON object only, exactly matching the required shape.';
const ANSWER_RETRY = 'Reply again with the answer as plain text.';
const EDIT_RETRY = `Reply again in exactly the required format: the header lines (${EDIT_FIELDS.filter(
  (field) => field !== 'QUESTION',
)
  .map((field) => `${field}:`)
  .join(', ')}) and CONTENT:, or a single QUESTION: line. No JSON.`;

export function getPromptBudget(contextTokens: number): number {
  return (contextTokens - REPLY_RESERVE_TOKENS) * CHARS_PER_TOKEN - CORRECTION_RESERVE_CHARS;
}

export function createPlanExchange(
  request: PlanningRequest,
  budget: number,
): ProtocolExchange<AssistantPlan> {
  const message = `User message:\n${request.message}`;
  const conversationBudget = budget - PLANNING_SYSTEM.length - message.length - 1;
  if (conversationBudget < MIN_COMPACT_CHARS) throw createTooLargeError();
  return {
    request: {
      system: PLANNING_SYSTEM,
      prompt: lines(message, conversationBlock(request.conversation, conversationBudget)),
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
      '',
      `Your previous reply was:\n${compact(rejected, REJECTED_REPLY_CHARS)}`,
      '',
      `It was rejected because: ${problem}.`,
      exchange.retryInstruction,
    ),
  };
}

function buildReplyPrompt(request: ReplyRequest, numbered: boolean, budget: number): string {
  const { evidence, plan } = request;
  const smallBlock = Math.floor(budget / SMALL_BLOCK_SHARE);
  const before = lines(
    `User message:\n${request.message}`,
    plan.reason ? `\nPlanner reason:\n${compact(plan.reason, smallBlock)}` : '',
    conversationBlock(request.conversation, smallBlock),
  );
  const after = lines(
    evidence.lineContext
      ? `\nLines around the caret:\n${compact(caretLines(evidence.lineContext), smallBlock)}`
      : '',
    evidence.selection ? `\nSelected text:\n${compact(evidence.selection, smallBlock)}` : '',
    evidence.logs ? `\nCompile logs:\n${compact(evidence.logs, smallBlock)}` : '',
  );
  const separators = after === '' ? 1 : 2;
  const documentBudget = budget - before.length - after.length - separators;
  if (documentBudget < MIN_DOCUMENT_CHARS) throw createTooLargeError();
  return lines(before, documentBlock(evidence.document, numbered, documentBudget), after);
}

function conversationBlock(conversation: readonly ConversationMessage[], maxChars: number): string {
  const recent = conversation.slice(-CONVERSATION_WINDOW);
  if (!recent.length) return '';
  const label = '\nConversation so far:\n';
  const text = recent.map((message) => `[${message.role}] ${message.text.trim()}`).join('\n');
  return `${label}${compact(text, maxChars - label.length)}`;
}

function caretLines(context: NonNullable<ReplyRequest['evidence']['lineContext']>): string {
  return context.lines
    .map((text, i) => `${String(context.firstLineNumber + i)}: ${text}`)
    .join('\n');
}

function documentBlock(snapshot: DocumentSnapshot, numbered: boolean, maxChars: number): string {
  const label = numbered ? '\nNumbered document lines:\n' : '\nDocument text:\n';
  const text = numbered
    ? snapshot.lines.map((line, index) => `${String(index + 1)}: ${line}`).join('\n')
    : documentText(snapshot);
  return `${label}${compact(text, maxChars - label.length)}`;
}

export function compact(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars < MIN_COMPACT_CHARS) {
    throw new InvariantViolation(`cannot compact text into ${String(maxChars)} characters`);
  }
  const keep = Math.floor((maxChars - 64) / 2);
  const omitted = text.length - 2 * keep;
  return `${text.slice(0, keep)}\n\n[...AUTOCOMPACTED... omitted ${String(omitted)} chars ...]\n\n${text.slice(-keep)}`;
}

function createTooLargeError(): AssistantRequestTooLargeError {
  return new AssistantRequestTooLargeError(
    "The message is too long for the model's context window; shorten it and try again.",
  );
}

function lines(...parts: string[]): string {
  return parts.filter((part) => part !== '').join('\n');
}
