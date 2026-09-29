import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Evidence } from '../../src/domain/assistant-plan';
import { createDocumentSnapshot } from '../../src/domain/document';
import { OllamaAssistant } from '../../src/infrastructure/ollama/ollama-assistant';
import { OllamaClient } from '../../src/infrastructure/ollama/ollama-client';
import type { GatheredEvidence } from '../../src/ports/assistant-port';
import { TestFixtureError } from '../support/test-errors';

const OLLAMA_URL = process.env.OLLAMA_CONTRACT_URL;
const CASE_TIMEOUT_MS = 300_000;

const source = readFileSync(new URL('../fixtures/overleaf-example.tex', import.meta.url), 'utf8');
const snapshot = createDocumentSnapshot(source.replace(/\n$/, '').split('\n'));
const lineOf = (needle: string): number => snapshot.lines.findIndex((l) => l.includes(needle)) + 1;
const lineText = (lineNumber: number): string => {
  const text = snapshot.lines[lineNumber - 1];
  if (text === undefined)
    throw new TestFixtureError(`the fixture has no line ${String(lineNumber)}`);
  return text;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new TestFixtureError(`${name} must be set together with OLLAMA_CONTRACT_URL`);
  }
  return value;
}

const gap = (operation: string, line: number): number => {
  let at = operation === 'insert_before' ? line - 1 : line;
  while (at > 0 && snapshot.lines[at - 1]?.trim() === '') at -= 1;
  return at;
};

interface Case {
  readonly request: string;
  readonly intent: 'summary' | 'explain' | 'edit';
  readonly answer?: RegExp;
  readonly operation?: 'insert_before' | 'insert_after' | 'replace' | 'delete';
  readonly line?: number;
  readonly lastLines?: readonly number[];
  readonly content?: RegExp;
  readonly selection?: string;
}

const CASES: Case[] = [
  { request: 'o czym jest ten dokument?', intent: 'summary', answer: /szablon|przykład|LaTeX/i },
  { request: 'wyjaśnij co oznacza wzór na S_n', intent: 'explain', answer: /średni/i },
  {
    request: 'dlaczego tabela z widgetami ma pionową kreskę?',
    intent: 'explain',
    answer: /\\begin\{tabular\}\{l\|r\}|l\|r/,
  },
  {
    request: 'popraw podpis rysunku z żabą, żeby brzmiał bardziej naukowo',
    intent: 'edit',
    operation: 'replace',
    line: lineOf('\\caption{\\label{fig:frog}'),
    content: /^\\caption\{\\label\{fig:frog\}[^\n]+\}$/,
  },
  {
    request: 'zmień tytuł na Raport z laboratorium',
    intent: 'edit',
    operation: 'replace',
    line: lineOf('\\title{'),
    content: /^\\title\{Raport z laboratorium\}$/,
  },
  {
    request: 'dodaj sekcję Conclusions z jednym zdaniem przed bibliografią',
    intent: 'edit',
    operation: 'insert_before',
    line: lineOf('\\bibliographystyle'),
    content: /\\section\{Conclusions\}/,
  },
  {
    request: 'wstaw po tabeli z widgetami tabelę z trzema pomiarami temperatury',
    intent: 'edit',
    operation: 'insert_after',
    line: lineOf('\\end{table}'),
    content:
      /^\\begin\{table\}[\s\S]*\\begin\{tabular\}[\s\S]*\\end\{tabular\}[\s\S]*\\end\{table\}$/,
  },
  {
    request: 'usuń akapit o track changes',
    intent: 'edit',
    operation: 'delete',
    line: lineOf('Track changes are available'),
    lastLines: [lineOf('Track changes are available'), lineOf('Track changes are available') + 1],
  },
  {
    request: 'usuń całą podsekcję o komentarzach i śledzeniu zmian razem z jej treścią',
    intent: 'edit',
    operation: 'delete',
    line: lineOf('\\subsection{How to add Comments and Track Changes}'),
    lastLines: [lineOf('Track changes are available'), lineOf('Track changes are available') + 1],
  },
  {
    request: 'przetłumacz zaznaczony akapit na polski',
    intent: 'edit',
    operation: 'replace',
    line: lineOf('Your introduction goes here'),
    selection: lineText(lineOf('Your introduction goes here')),
  },
];

function createContractAssistant(): OllamaAssistant {
  const client = new OllamaClient(
    {
      endpoint: requireEnv('OLLAMA_CONTRACT_URL'),
      model: requireEnv('OLLAMA_CONTRACT_MODEL'),
      contextTokens: Number(requireEnv('OLLAMA_CONTRACT_CONTEXT_TOKENS')),
      timeoutMs: CASE_TIMEOUT_MS,
    },
    (input, init) => fetch(input, init),
  );
  return new OllamaAssistant(client);
}

describe.runIf(OLLAMA_URL)('Ollama contract', () => {
  let assistant: OllamaAssistant;

  beforeAll(() => {
    assistant = createContractAssistant();
  });

  it.each(CASES)(
    '$request',
    async (c) => {
      const plan = await assistant.plan({ message: c.request, conversation: [] });
      expect(plan.intent).toBe(c.intent);

      const needs = new Set(plan.needs);
      const evidence: GatheredEvidence = {
        document: snapshot,
        ...(c.selection && needs.has(Evidence.Selection) ? { selection: c.selection } : {}),
      };
      const reply = await assistant.reply({ message: c.request, plan, evidence, conversation: [] });

      if (c.intent !== 'edit') {
        expect(reply.kind).toBe('answer');
        if (reply.kind === 'answer' && c.answer) expect(reply.text).toMatch(c.answer);
        return;
      }
      expect(reply.kind).toBe('edit');
      if (reply.kind !== 'edit') return;
      const { command } = reply.edit;
      const { target } = command;
      if (c.operation?.startsWith('insert') && command.operation.startsWith('insert')) {
        expect(gap(command.operation, target.lineNumber)).toBe(gap(c.operation, c.line ?? 0));
      } else {
        expect(command.operation).toBe(c.operation);
        expect(target.lineNumber).toBe(c.line);
      }
      if (c.lastLines && (command.operation === 'replace' || command.operation === 'delete')) {
        expect(c.lastLines).toContain(target.lineNumber + command.lineCount - 1);
      }
      if (c.content) expect('content' in command ? command.content : '').toMatch(c.content);
    },
    CASE_TIMEOUT_MS,
  );
});
