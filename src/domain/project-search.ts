import type { SearchMatch } from './agent-transcript';
import type { DocumentSnapshot } from './document';

export const MAX_SEARCH_MATCHES = 20;

export interface SearchedFile {
  readonly path: string;
  readonly document: DocumentSnapshot;
}

export interface SearchOutcome {
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
}

export function searchProject(files: readonly SearchedFile[], query: string): SearchOutcome {
  const needle = query.toLowerCase();
  const all = files.flatMap(({ path, document }) =>
    document.lines.flatMap((lineText, index) =>
      lineText.toLowerCase().includes(needle) ? [{ path, lineNumber: index + 1, lineText }] : [],
    ),
  );
  return {
    matches: Object.freeze(all.slice(0, MAX_SEARCH_MATCHES)),
    truncated: all.length > MAX_SEARCH_MATCHES,
  };
}
