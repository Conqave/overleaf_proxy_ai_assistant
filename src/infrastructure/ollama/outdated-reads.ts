import { AgentTool } from '../../domain/agent-action';
import type { ReadRecord, ToolRecord } from '../../domain/agent-transcript';
import { isSpanCovering } from '../../domain/read-window';

export function findOutdatedReads(records: readonly ToolRecord[]): ReadonlySet<ToolRecord> {
  const reads = records.filter(
    (record): record is ReadRecord => record.tool === AgentTool.ReadFile,
  );
  return new Set(
    reads.filter((read, index) =>
      reads
        .slice(index + 1)
        .some((later) => later.path === read.path && isSpanCovering(later.shown, read.shown)),
    ),
  );
}

export function renderUnlessOutdated(
  record: ToolRecord,
  outdated: ReadonlySet<ToolRecord>,
  render: (record: ToolRecord) => string,
): string {
  if (record.tool !== AgentTool.ReadFile || !outdated.has(record)) return render(record);
  return `[outdated — see the later read of ${record.path}]`;
}
