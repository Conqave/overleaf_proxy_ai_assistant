import { AgentTool } from '../domain/agent-action';
import type { ToolResult } from '../domain/agent-transcript';
import { searchProject } from '../domain/project-search';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';
import type { ProjectToolRun } from './agent-decision';

export class ProjectTools {
  constructor(private readonly project: ProjectPort) {}

  async run(
    run: ProjectToolRun,
    onProgress: (progress: AgentProgress) => void,
  ): Promise<ToolResult> {
    switch (run.tool) {
      case AgentTool.ReadFile:
        onProgress({ stage: 'reading', path: run.file.path });
        return {
          tool: run.tool,
          path: run.file.path,
          document: await this.project.readFile(run.file),
        };
      case AgentTool.Search: {
        onProgress({ stage: 'searching', query: run.query });
        const searched = await Promise.all(
          run.files.map(async (file) => ({
            path: file.path,
            document: await this.project.readFile(file),
          })),
        );
        return { tool: run.tool, ...searchProject(searched, run.query) };
      }
      case AgentTool.Compile:
        onProgress({ stage: 'compiling' });
        return { tool: run.tool, diagnostics: await this.project.compile() };
    }
  }
}
