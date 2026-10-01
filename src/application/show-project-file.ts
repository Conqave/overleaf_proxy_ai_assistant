import { findTextFile } from '../domain/project-file';
import type { ProjectPort } from '../ports/project-port';
import type { AgentProgress } from './agent-progress';

export async function showProjectFile(
  project: ProjectPort,
  path: string,
  onProgress: (progress: AgentProgress) => void,
): Promise<void> {
  if (project.openFilePath() === path) return;
  const file = findTextFile(project.listFiles(), path);
  onProgress({ stage: 'opening', path });
  await project.openFile(file);
}
