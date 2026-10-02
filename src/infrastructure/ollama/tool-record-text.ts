import { AgentTool } from '../../domain/agent-action';
import type { CompileDiagnostic, DelegateRecord, ToolRecord } from '../../domain/agent-transcript';
import { DelegationOutcome } from '../../domain/delegation';
import { numberLine } from '../../domain/read-window';
import { SEARCH_OUTPUT_CHARS } from './context-budget';
import { AgentField, EditField } from './reply-format';
import { compact, LINE_BREAK, lines } from './prompt-blocks';

const NO_PROBLEMS = '(no problems)';
const NO_MATCHES = '(no matches)';
const EMPTY_FILE = '(empty file)';
const MORE_MATCHES = '(more matches or text omitted; search for something more specific)';

interface RecordText {
  readonly preface: readonly string[];
  readonly body: string;
  readonly notices: readonly string[];
}

export function describeRecord(record: ToolRecord): string {
  switch (record.tool) {
    case AgentTool.ReadFile:
      if (record.totalLines === 0) return `${record.tool} ${record.path}`;
      return `${record.tool} ${record.path} lines ${String(record.shown.first)}–${String(record.shown.last)} of ${String(record.totalLines)}`;
    case AgentTool.Search:
      return describeSearch(record.query, record.path);
    case AgentTool.Compile:
      return record.tool;
    case AgentTool.Delegate:
      return `${record.tool} ${JSON.stringify(record.task)}`;
  }
}

export function describeSearch(query: string, path: string | undefined): string {
  const searched = `${AgentTool.Search} ${JSON.stringify(query)}`;
  return path === undefined ? searched : `${searched} in ${path}`;
}

export function renderShortRecord(
  record: ToolRecord,
  maxChars: number,
  fullerLookup: string,
): string {
  const { preface, body, notices } = recordText(record);
  if (body.length <= maxChars) return lines(...preface, body, ...notices);
  return lines(
    ...preface,
    compact(body, maxChars),
    ...notices,
    `[shortened to ${String(maxChars)} characters; ${fullerLookup}]`,
  );
}

function recordText(record: ToolRecord): RecordText {
  switch (record.tool) {
    case AgentTool.ReadFile: {
      if (record.totalLines === 0) return { preface: [], body: EMPTY_FILE, notices: [] };
      const { first, last } = record.shown;
      const body = lines(...record.lines.map((text, index) => numberLine(first + index, text)));
      if (first === 1 && last === record.totalLines) return { preface: [], body, notices: [] };
      return {
        preface: [
          `[Showing only lines ${String(first)}–${String(last)} of ${String(record.totalLines)}; the file has ${String(record.totalLines)} lines and the others exist but are not shown here. Read another range with ${AgentField.StartLine} and ${EditField.EndLine}, or search.]`,
        ],
        body,
        notices: [],
      };
    }
    case AgentTool.Search: {
      const found = record.matches.map(
        (match) => `${match.path}:${String(match.lineNumber)}: ${match.lineText}`,
      );
      const listed = found.length ? lines(...found) : NO_MATCHES;
      const body = compact(listed, SEARCH_OUTPUT_CHARS);
      const isComplete = !record.truncated && body === listed;
      return { preface: [], body, notices: isComplete ? [] : [MORE_MATCHES] };
    }
    case AgentTool.Compile:
      return { preface: [], body: diagnosticsText(record.diagnostics), notices: [] };
    case AgentTool.Delegate:
      return delegationText(record);
  }
}

function delegationText({ report }: DelegateRecord): RecordText {
  const lookups = `${String(report.lookups)} ${report.lookups === 1 ? 'lookup' : 'lookups'}`;
  switch (report.outcome) {
    case DelegationOutcome.Finished:
      return {
        preface: [`[findings of the helper after ${lookups}]`],
        body: report.text,
        notices: report.truncated
          ? ['[the findings were cut at the length limit; delegate a narrower task for the rest]']
          : [],
      };
    case DelegationOutcome.Failed:
      return {
        preface: [`[the helper stopped without findings after ${lookups}]`],
        body: report.problem,
        notices: [],
      };
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
