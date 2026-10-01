import { AgentTool } from '../domain/agent-action';
import type { ToolResult } from '../domain/agent-transcript';
import type { DocumentSnapshot } from '../domain/document';
import type { TextFile } from '../domain/project-file';
import { searchProject, type SearchedFile } from '../domain/project-search';
import type { CancellationController, CancellationSignal } from '../ports/cancellation';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';
import type { ProjectToolRun } from './agent-decision';

export const PARALLEL_SEARCH_READS = 4;

export class ProjectTools {
  constructor(
    private readonly project: ProjectPort,
    private readonly createController: () => CancellationController,
  ) {}

  async run(
    run: ProjectToolRun,
    onProgress: (progress: AgentProgress) => void,
    signal: CancellationSignal,
  ): Promise<ToolResult> {
    switch (run.tool) {
      case AgentTool.ReadFile:
        onProgress({ stage: 'reading', path: run.file.path });
        return {
          tool: run.tool,
          path: run.file.path,
          document: await this.project.readFile(run.file, signal),
        };
      case AgentTool.Search: {
        onProgress({ stage: 'searching', query: run.query });
        const searched = await this.readAll(run.files, signal);
        return { tool: run.tool, ...searchProject(searched, run.query) };
      }
      case AgentTool.Compile:
        onProgress({ stage: 'compiling' });
        return { tool: run.tool, diagnostics: await this.project.compile(signal) };
    }
  }

  private async readAll(
    files: readonly TextFile[],
    signal: CancellationSignal,
  ): Promise<SearchedFile[]> {
    const reads = this.createController();
    const cancelReads = (): void => {
      reads.abort(signal.reason);
    };
    if (signal.aborted) cancelReads();
    signal.addEventListener('abort', cancelReads);
    const searched: SearchedFile[] = [];
    const queue = files.entries();
    const readQueued = async (): Promise<void> => {
      for (const [index, file] of queue) {
        searched[index] = { path: file.path, document: await this.readOne(file, reads) };
      }
    };
    const readers = Array.from({ length: Math.min(PARALLEL_SEARCH_READS, files.length) }, () =>
      readQueued(),
    );
    await Promise.allSettled(readers);
    signal.removeEventListener('abort', cancelReads);
    if (reads.signal.aborted) throw reads.signal.reason;
    return searched;
  }

  private async readOne(file: TextFile, reads: CancellationController): Promise<DocumentSnapshot> {
    try {
      return await this.project.readFile(file, reads.signal);
    } catch (error) {
      reads.abort(error);
      throw error;
    }
  }
}
