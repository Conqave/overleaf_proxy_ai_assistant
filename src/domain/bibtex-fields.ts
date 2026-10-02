import { BibFieldSeparatorError } from './errors';
import type { ResolvedEdit } from './resolved-edit';

const BIB_EXTENSION = '.bib';
const ENTRY_START = /^\s*@\w+\s*\{/;
const ENTRY_END = /^\s*\}\s*$/;
const FIELD_START = /^\s*[A-Za-z][\w-]*\s*=/;
const FIELD_SEPARATOR = ',';

interface SourceLine {
  readonly lineNumber: number;
  readonly text: string;
}

export function assertBibFieldsSeparated(path: string, edit: ResolvedEdit): void {
  if (!path.toLowerCase().endsWith(BIB_EXTENSION)) return;
  const { splice } = edit;
  const lines = [...edit.document.lines];
  lines.splice(splice.line - 1, splice.removed.length, ...splice.inserted);
  const first = splice.line - 1;
  const last = splice.line - 1 + splice.inserted.length;
  const unseparated = findUnseparatedFields(lines).find(
    ({ lineNumber }) => first <= lineNumber && lineNumber <= last,
  );
  if (unseparated === undefined) return;
  throw new BibFieldSeparatorError(
    `after this edit, line ${String(unseparated.lineNumber)} of ${path} (${unseparated.text.trim()}) is followed by another field of its entry but does not end with a comma, so BibTeX cannot read the entry; replace that line with the same text ending in a comma followed by the new field, in one replace block`,
  );
}

function findUnseparatedFields(lines: readonly string[]): SourceLine[] {
  const unseparated: SourceLine[] = [];
  let inEntry = false;
  let valueEnd: SourceLine | null = null;
  lines.forEach((text, index) => {
    if (ENTRY_START.test(text)) {
      inEntry = true;
      valueEnd = null;
      return;
    }
    if (!inEntry) return;
    if (ENTRY_END.test(text)) {
      inEntry = false;
      return;
    }
    if (FIELD_START.test(text) && valueEnd !== null && !hasSeparator(valueEnd)) {
      unseparated.push(valueEnd);
    }
    if (text.trim() !== '') valueEnd = { lineNumber: index + 1, text };
  });
  return unseparated;
}

function hasSeparator({ text }: SourceLine): boolean {
  return text.trimEnd().endsWith(FIELD_SEPARATOR);
}
