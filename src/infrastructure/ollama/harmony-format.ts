import type { GenerateRequest } from './ollama-client';

const START = '<|start|>';
const END = '<|end|>';
const MESSAGE = '<|message|>';
const CHANNEL = '<|channel|>';

const ASSISTANT_START = `${START}assistant`;
const ANALYSIS_START = `${CHANNEL}analysis${MESSAGE}`;
const FINAL_START = `${CHANNEL}final${MESSAGE}`;

const SYSTEM_HEADER = [
  'Reasoning: medium',
  '',
  '# Valid channels: analysis, commentary, final. Channel must be included for every message.',
].join('\n');

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
  if (finalStart !== -1) return { kind: 'final', text: raw.slice(finalStart + FINAL_START.length) };
  const analysisStart = raw.indexOf(ANALYSIS_START);
  if (analysisStart === -1) return { kind: 'unfinished', analysis: '' };
  const analysis = raw.slice(analysisStart + ANALYSIS_START.length);
  const analysisEnd = analysis.indexOf(END);
  return {
    kind: 'unfinished',
    analysis: analysisEnd === -1 ? analysis : analysis.slice(0, analysisEnd),
  };
}

export function renderFinalContinuation(prompt: string, analysis: string): string {
  return `${prompt}${ANALYSIS_START}${analysis}${END}${ASSISTANT_START}${FINAL_START}`;
}

function renderMessage(role: 'system' | 'developer' | 'user', content: string): string {
  return `${START}${role}${MESSAGE}${content}${END}`;
}
