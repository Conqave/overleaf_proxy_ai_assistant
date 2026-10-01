import { AgentTool, type ToolCall } from '../domain/agent-action';
import type { ToolResult } from '../domain/agent-transcript';
import { findTextFile, listTextFiles, type ProjectFile } from '../domain/project-file';
import { searchProject } from '../domain/project-search';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';

export class ProjectTools {
  constructor(private readonly project: ProjectPort) {}

  async run(
    call: ToolCall,
    files: readonly ProjectFile[],
    onProgress: (progress: AgentProgress) => void,
  ): Promise<ToolResult> {
    switch (call.tool) {
      case AgentTool.ReadFile: {
        const file = findTextFile(files, call.path);
        onProgress({ stage: 'reading', path: call.path });
        return { tool: call.tool, path: call.path, document: await this.project.readFile(file) };
      }
      case AgentTool.Search: {
        onProgress({ stage: 'searching', query: call.query });
        const searched = await Promise.all(
          listTextFiles(files).map(async (file) => ({
            path: file.path,
            document: await this.project.readFile(file),
          })),
        );
        return { tool: call.tool, ...searchProject(searched, call.query) };
      }
      case AgentTool.Compile:
        onProgress({ stage: 'compiling' });
        return { tool: call.tool, diagnostics: await this.project.compile() };
    }
  }
}
