import { describe, expect, it } from 'vitest';
import {
  InvalidAssistantResponse,
  parseAnswerResponse,
  parseEditResponse,
  parsePlanResponse,
} from '../../../src/infrastructure/ollama/assistant-response-parser';
import { createDocumentSnapshot } from '../../../src/domain/document';

const json = (value: unknown) => JSON.stringify(value);

describe('parsePlanResponse', () => {
  it('returns a validated plan', () => {
    expect(parsePlanResponse(json({ intent: 'summary', needs: ['logs'], reason: 'r' }))).toEqual({
      intent: 'summary',
      needs: ['logs'],
      reason: 'r',
    });
  });

  it.each([
    ['empty response', ''],
    ['whitespace only', '  \n '],
    ['invalid JSON', '{"intent": "summary",'],
    ['prose', 'Sure! The document is about sections.'],
    ['markdown fenced JSON', '```json\n{"intent":"summary"}\n```'],
    ['JSON array', '[{"intent":"summary"}]'],
    ['unknown intent', json({ intent: 'insert' })],
    ['missing intent', json({ needs: [] })],
    ['wrong needs type', json({ intent: 'edit', needs: 'document' })],
    ['unknown property', json({ intent: 'edit', confidence: 0.9 })],
    ['a question from the planner', json({ intent: 'clarify', question: 'Which table?' })],
  ])('rejects %s', (_name, raw) => {
    expect(() => parsePlanResponse(raw)).toThrow(InvalidAssistantResponse);
  });
});

describe('parseEditResponse', () => {
  const shown = createDocumentSnapshot([
    '\\title{A}',
    '',
    '\\section{Results}',
    'Long paragraph. More.',
  ]);
  const edit = (
    overrides: Record<string, string | null> = {},
    content = '\\begin{table}\n\\end{table}',
  ) => {
    const fields: Record<string, string | null> = {
      OPERATION: 'insert_after',
      LINE: '3',
      LINE_TEXT: '\\section{Results}',
      REASON: 'Adds a table.',
      PLAN: 'After the results heading.',
      ...overrides,
    };
    const head = Object.entries(fields)
      .filter(([, value]) => value !== null)
      .map(([name, value]) => `${name}: ${value ?? ''}`);
    return [...head, ...(content === '' ? [] : ['CONTENT:', content])].join('\n');
  };

  const parse = (raw: string) => parseEditResponse(raw, shown);

  it('returns a validated edit resolved against the shown document', () => {
    const content = '\\begin{tabular}{l|r}\nA & 1 \\\\\\hline\n\\end{tabular}';
    const reply = parse(edit({}, content));
    expect(reply).toMatchObject({
      kind: 'edit',
      rationale: 'After the results heading.',
      edit: {
        document: shown,
        command: {
          operation: 'insert_after',
          target: { lineNumber: 3, lineText: '\\section{Results}' },
          content,
          reason: 'Adds a table.',
        },
      },
    });
  });

  it('keeps leading blank lines of the content and drops trailing ones', () => {
    expect(parse(edit({}, '\n\\section{X}\n\n'))).toMatchObject({
      edit: { command: { content: '\n\\section{X}' } },
    });
  });

  it('accepts Windows line endings', () => {
    expect(parse(edit({}, 'X').replace(/\n/g, '\r\n'))).toMatchObject({
      edit: { command: { operation: 'insert_after', content: 'X' } },
    });
  });

  it('accepts a delete of one line without content or END_LINE', () => {
    expect(parse(edit({ OPERATION: 'delete' }, ''))).toMatchObject({
      edit: { command: { operation: 'delete', lineCount: 1 } },
    });
  });

  it('reads END_LINE as the last line of a replaced or deleted range', () => {
    expect(parse(edit({ OPERATION: 'replace', END_LINE: '4' }, 'New.'))).toMatchObject({
      edit: { command: { operation: 'replace', target: { lineNumber: 3 }, lineCount: 2 } },
    });
    expect(parse(edit({ OPERATION: 'delete', END_LINE: '4' }, ''))).toMatchObject({
      edit: { command: { operation: 'delete', lineCount: 2 } },
    });
  });

  it('tells the model when END_LINE is before LINE or given for an insertion', () => {
    expect(() => parse(edit({ OPERATION: 'delete', END_LINE: '2' }, ''))).toThrow(
      'the delete range must end at or after its first line 3',
    );
    expect(() => parse(edit({ END_LINE: '4' }))).toThrow('takes no range end');
  });

  it('sends a range past the end of the shown document back to the model', () => {
    expect(() => parse(edit({ OPERATION: 'delete', END_LINE: '9' }, ''))).toThrow(
      'END_LINE must be a line of the document',
    );
  });

  it('reads an empty CONTENT block as no content', () => {
    expect(parse(`${edit({ OPERATION: 'delete' }, '')}\nCONTENT:\n`)).toMatchObject({
      edit: { command: { operation: 'delete' } },
    });
    expect(() => parse(`${edit({}, '')}\nCONTENT:`)).toThrow('requires non-empty content');
  });

  it('accepts an edit without the optional REASON and PLAN', () => {
    const reply = parse(edit({ REASON: null, PLAN: null }));
    expect(reply).toMatchObject({ kind: 'edit' });
    expect(reply).not.toHaveProperty('rationale');
    expect(reply).not.toHaveProperty('edit.command.reason');
    expect(parse(edit({ REASON: '', PLAN: '' }))).not.toHaveProperty('rationale');
  });

  it('completes a long line from its quoted start', () => {
    const long = createDocumentSnapshot([
      'Track changes are available on all plans. They record every edit.',
    ]);
    const reply = parseEditResponse(
      'OPERATION: delete\nLINE: 1\nLINE_TEXT: Track changes are available on all plans.',
      long,
    );
    expect(reply).toMatchObject({ edit: { command: { target: { lineText: long.lines[0] } } } });
  });

  it('tells the model which line starts with the text it quoted', () => {
    expect(() => parse(edit({ LINE: '2', LINE_TEXT: '\\section{Results}' }))).toThrow(
      'which is an empty line; the text you quoted starts line 3',
    );
  });

  it('returns a question as a question', () => {
    expect(parse('QUESTION: Which table?')).toEqual({ kind: 'question', text: 'Which table?' });
  });

  it('tells the model when it answered in JSON instead of header lines', () => {
    const json = JSON.stringify({ OPERATION: 'delete', LINE: 3, LINE_TEXT: '\\section{Results}' });
    expect(() => parse(json)).toThrow('the reply is JSON');
  });

  it('names the real line when LINE_TEXT does not match what the model was shown', () => {
    expect(() => parse(edit({ LINE: '4', LINE_TEXT: 'Long paragraph.' }))).toThrow(
      'which reads: Long paragraph. More.',
    );
    expect(() => parse(edit({ LINE: '9', LINE_TEXT: 'x' }))).toThrow('the document has 4 lines');
  });

  it.each([
    ['empty response', ''],
    ['JSON instead of the edit format', JSON.stringify({ type: 'edit' })],
    ['unknown field', edit({ ANCHOR: 'x' })],
    ['field glued to its value', edit().replace('LINE: 3', 'LINE:3')],
    ['field twice', edit().replace('CONTENT:', 'LINE: 3\nCONTENT:')],
    ['unknown operation', edit({ OPERATION: 'explain' })],
    ['legacy operation', edit({ OPERATION: 'replace_line' })],
    ['missing line', edit({ LINE: null })],
    ['line as text', edit({ LINE: 'three' })],
    ['missing line text', edit({ LINE_TEXT: null })],
    ['END_LINE before LINE', edit({ OPERATION: 'delete', END_LINE: '2' }, '')],
    ['END_LINE as text', edit({ OPERATION: 'delete', END_LINE: 'four' }, '')],
    ['END_LINE on an insertion', edit({ END_LINE: '4' })],
    ['missing content', edit({}, '')],
    ['content on delete', edit({ OPERATION: 'delete' })],
    ['fenced content', edit({}, '```latex\n\\section{X}\n```')],
    ['question with an edit', `QUESTION: Why?\n${edit()}`],
    ['empty question', 'QUESTION: '],
  ])('rejects %s', (_name, raw) => {
    expect(() => parse(raw)).toThrow(InvalidAssistantResponse);
  });
});

describe('parseAnswerResponse', () => {
  it('returns the plain text with LaTeX intact', () => {
    expect(parseAnswerResponse('  Use \\begin{tabular}{l|r} and \\frac{1}{n}. ')).toBe(
      'Use \\begin{tabular}{l|r} and \\frac{1}{n}.',
    );
  });

  it('rejects an empty reply', () => {
    expect(() => parseAnswerResponse('  ')).toThrow(InvalidAssistantResponse);
  });
});
