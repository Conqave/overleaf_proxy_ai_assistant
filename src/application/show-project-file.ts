import type { TextFile } from '../domain/project-file';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';

export async function showProjectFile(
  project: ProjectPort,
  file: TextFile,
  onProgress: (progress: AgentProgress) => void,
): Promise<void> {
  if (project.openFilePath() === file.path) return;
  onProgress({ stage: 'opening', path: file.path });
  await project.openFile(file);
}
