import { AGENT_POLICY } from './agent-policy';
import type { SearchMatch } from './agent-transcript';
import type { DocumentSnapshot } from './document';

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
    matches: Object.freeze(all.slice(0, AGENT_POLICY.maxSearchMatches)),
    truncated: all.length > AGENT_POLICY.maxSearchMatches,
  };
}
