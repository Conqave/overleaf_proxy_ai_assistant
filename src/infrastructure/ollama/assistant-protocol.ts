import {
  AssistantMessageKind,
  type ConversationMessage,
  type GreetingMessage,
} from '../../domain/conversation';
import { DocumentOperation, type DocumentCommand } from '../../domain/document-command';
import { InvariantViolation } from '../../domain/errors';
import { AssistantRequestTooLargeError } from '../../ports/errors';
import { CONTENT, CONTENT_MARKER, EditField, fieldLine } from './edit-reply-format';
import { MAX_COMPLETION_TOKENS, type GenerateRequest } from './ollama-client';

export const MIN_CONTEXT_TOKENS = 16_384;
const REPLY_RESERVE_TOKENS = 2 * MAX_COMPLETION_TOKENS;
const CHARS_PER_TOKEN = 3;
const CONVERSATION_WINDOW = 12;
export const SMALL_BLOCK_SHARE = 8;
const REJECTED_REPLY_CHARS = 3_000;
const CORRECTION_RESERVE_CHARS = 4_096;
const MIN_KEPT_CHARS = 32;

export const LINE_BREAK = '\n';
const COMPACT_GAP = LINE_BREAK.repeat(2);
const COMPACT_MARKER_CHARS = compactMarker(Number.MAX_SAFE_INTEGER).length;
const MIN_COMPACT_CHARS = COMPACT_MARKER_CHARS + 2 * MIN_KEPT_CHARS;

const USER_MESSAGE_LABEL = 'User message:';
export const CONVERSATION_LABEL = 'Conversation so far:';
export const SELECTION_LABEL = 'Selected text:';

export interface ProtocolExchange<T> {
  readonly request: GenerateRequest;
  readonly retryInstruction: string;
  readonly parse: (raw: string) => T;
}

export const LANGUAGE_RULE =
  'Write every user-facing text in the language of the user message (Polish message → Polish text). Text that goes into a file keeps the language of that file unless the user asks for a translation, and names and titles the user gives are used exactly as given, untranslated ("dodaj sekcję Conclusions" → \\section{Conclusions}).';
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

export function getPromptBudget(contextTokens: number): number {
  return (contextTokens - REPLY_RESERVE_TOKENS) * CHARS_PER_TOKEN - CORRECTION_RESERVE_CHARS;
}

export function estimatePromptTokens(request: GenerateRequest): number {
  return Math.ceil((request.system.length + request.prompt.length) / CHARS_PER_TOKEN);
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

function compact(text: string, maxChars: number): string {
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
