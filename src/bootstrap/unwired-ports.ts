import type { CompileDiagnostic } from '../domain/agent-transcript';
import type { DocumentSnapshot } from '../domain/document';
import type { ProjectFile } from '../domain/project-file';
import type { AgentPort, AgentStep } from '../ports/agent-port';
import type { ProjectPort } from '../ports/project-port';

export class PortNotWiredError extends Error {
  constructor(port: string) {
    super(`${port} has no adapter wired in the bootstrap`);
    this.name = new.target.name;
  }
}

export class UnwiredAgent implements AgentPort {
  decide(): Promise<AgentStep> {
    return Promise.reject(new PortNotWiredError('AgentPort'));
  }
}

export class UnwiredProject implements ProjectPort {
  listFiles(): readonly ProjectFile[] {
    throw new PortNotWiredError('ProjectPort');
  }
  openFilePath(): string {
    throw new PortNotWiredError('ProjectPort');
  }
  readFile(): Promise<DocumentSnapshot> {
    return Promise.reject(new PortNotWiredError('ProjectPort'));
  }
  openFile(): Promise<void> {
    return Promise.reject(new PortNotWiredError('ProjectPort'));
  }
  compile(): Promise<readonly CompileDiagnostic[]> {
    return Promise.reject(new PortNotWiredError('ProjectPort'));
  }
}
