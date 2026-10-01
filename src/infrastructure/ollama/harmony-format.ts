import { NamedError } from '../../domain/errors';
import type { GenerateRequest } from './ollama-client';

const START = '<|start|>';
const END = '<|end|>';
const MESSAGE = '<|message|>';
const CHANNEL = '<|channel|>';
const TOKEN_OPENING = '<|';
const NEUTRAL_OPENING = '<\uFF5C';
const CONTROL_TOKEN = /<\|[^|\s]*\|>/;

const ASSISTANT_START = `${START}assistant`;
const ANALYSIS_START = `${CHANNEL}analysis${MESSAGE}`;
const FINAL_START = `${CHANNEL}final${MESSAGE}`;

const SYSTEM_HEADER = [
  'Reasoning: medium',
  '',
  '# Valid channels: analysis, commentary, final. Channel must be included for every message.',
].join('\n');

export const HARMONY_FRAMING_CHARS = renderFinalContinuation(
  renderHarmonyPrompt({ system: '', prompt: '' }),
  '',
).length;

export class HarmonyFormatError extends NamedError {
  constructor(
    readonly problem: string,
    readonly completion: string,
  ) {
    super(`invalid harmony completion: ${problem}`);
  }
}

export type HarmonyCompletion =
  | { readonly kind: 'final'; readonly text: string }
  | { readonly kind: 'unfinished'; readonly analysis: string };

export function renderHarmonyPrompt(request: GenerateRequest): string {
  return [
    renderMessage('system', SYSTEM_HEADER),
    renderMessage('developer', `# Instructions\n\n${request.system}`),
    renderMessage('user', request.prompt),
    ASSISTANT_START,
  ].join('');
}

export function parseHarmonyCompletion(raw: string): HarmonyCompletion {
  const finalStart = raw.lastIndexOf(FINAL_START);
  if (finalStart !== -1) {
    return { kind: 'final', text: parseFinalText(raw.slice(finalStart + FINAL_START.length), raw) };
  }
  const analysisStart = raw.indexOf(ANALYSIS_START);
  if (analysisStart === -1) {
    throw new HarmonyFormatError('the reply has no final message; write it as plain text', raw);
  }
  const analysis = raw.slice(analysisStart + ANALYSIS_START.length);
  const analysisEnd = analysis.indexOf(END);
  return {
    kind: 'unfinished',
    analysis: analysisEnd === -1 ? analysis : analysis.slice(0, analysisEnd),
  };
}

export function parseFinalContinuation(raw: string): string {
  return parseFinalText(raw, raw);
}

function parseFinalText(text: string, raw: string): string {
  const token = CONTROL_TOKEN.exec(text);
  if (token !== null) {
    throw new HarmonyFormatError(
      `the reply contains the control token ${token[0]}; write plain text only`,
      raw,
    );
  }
  return text;
}

export function renderFinalContinuation(prompt: string, analysis: string): string {
  return `${prompt}${ANALYSIS_START}${neutralise(analysis)}${END}${ASSISTANT_START}${FINAL_START}`;
}

function renderMessage(role: 'system' | 'developer' | 'user', content: string): string {
  return `${START}${role}${MESSAGE}${neutralise(content)}${END}`;
}

function neutralise(content: string): string {
  return content.replaceAll(TOKEN_OPENING, NEUTRAL_OPENING);
}
