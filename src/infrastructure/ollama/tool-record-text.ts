import { AgentTool } from '../../domain/agent-action';
import type { CompileDiagnostic, ToolRecord } from '../../domain/agent-transcript';
import { numberLine } from '../../domain/read-window';
import { SEARCH_OUTPUT_CHARS } from './context-budget';
import { AgentField, EditField } from './reply-format';
import { compact, LINE_BREAK, lines } from './prompt-blocks';

const NO_PROBLEMS = '(no problems)';
const NO_MATCHES = '(no matches)';
const EMPTY_FILE = '(empty file)';
const MORE_MATCHES = '(more matches or text omitted; search for something more specific)';

interface RecordText {
  readonly body: string;
  readonly notices: readonly string[];
}

export function describeRecord(record: ToolRecord): string {
  switch (record.tool) {
    case AgentTool.ReadFile:
      if (record.totalLines === 0) return `${record.tool} ${record.path}`;
      return `${record.tool} ${record.path} lines ${String(record.shown.first)}–${String(record.shown.last)} of ${String(record.totalLines)}`;
    case AgentTool.Search:
      return `${record.tool} ${JSON.stringify(record.query)}`;
    case AgentTool.Compile:
      return record.tool;
  }
}

export function renderShortRecord(
  record: ToolRecord,
  maxChars: number,
  fullerLookup: string,
): string {
  const { body, notices } = recordText(record);
  if (body.length <= maxChars) return lines(body, ...notices);
  return lines(
    compact(body, maxChars),
    ...notices,
    `[shortened to ${String(maxChars)} characters; ${fullerLookup}]`,
  );
}

function recordText(record: ToolRecord): RecordText {
  switch (record.tool) {
    case AgentTool.ReadFile: {
      if (record.totalLines === 0) return { body: EMPTY_FILE, notices: [] };
      const { first, last } = record.shown;
      const body = lines(...record.lines.map((text, index) => numberLine(first + index, text)));
      if (first === 1 && last === record.totalLines) return { body, notices: [] };
      return {
        body,
        notices: [
          `[Showing lines ${String(first)}–${String(last)} of ${String(record.totalLines)}. Read another range with ${AgentField.StartLine} and ${EditField.EndLine}, or search.]`,
        ],
      };
    }
    case AgentTool.Search: {
      const found = record.matches.map(
        (match) => `${match.path}:${String(match.lineNumber)}: ${match.lineText}`,
      );
      const listed = found.length ? lines(...found) : NO_MATCHES;
      const body = compact(listed, SEARCH_OUTPUT_CHARS);
      const isComplete = !record.truncated && body === listed;
      return { body, notices: isComplete ? [] : [MORE_MATCHES] };
    }
    case AgentTool.Compile:
      return { body: diagnosticsText(record.diagnostics), notices: [] };
  }
}

export function diagnosticsText(diagnostics: readonly CompileDiagnostic[]): string {
  return diagnostics.length ? diagnostics.map(diagnosticLine).join(LINE_BREAK) : NO_PROBLEMS;
}

function diagnosticLine(diagnostic: CompileDiagnostic): string {
  return `${diagnostic.level} ${diagnosticPlace(diagnostic)}${diagnostic.message}`;
}

function diagnosticPlace({ path, lineNumber }: CompileDiagnostic): string {
  if (path === undefined) return '';
  if (lineNumber === undefined) return `${path}: `;
  return `${path}:${String(lineNumber)}: `;
}
