import type { ProjectFile } from '../../domain/project-file';
import type { SessionExport } from '../../domain/session-export';
import type { CancellationSignal } from '../../ports/cancellation';
import { UnreadableSessionExportError } from '../../ports/errors';
import type { SessionArchive } from '../../ports/session-archive';
import type { OverleafProjectFiles } from '../overleaf/overleaf-project-files';
import { parseSessionExport, serializeSessionExport } from './session-export-format';
import { UnknownStoredFormatError } from './stored-fields';

export class ProjectSessionArchive implements SessionArchive {
  constructor(private readonly files: OverleafProjectFiles) {}

  save(path: string, exported: SessionExport, signal: CancellationSignal): Promise<void> {
    return this.files.write(path, serializeSessionExport(exported), signal);
  }

  async load(file: ProjectFile, signal: CancellationSignal): Promise<SessionExport> {
    const text = await this.files.read(file, signal);
    try {
      return parseSessionExport(text);
    } catch (error) {
      if (!(error instanceof UnknownStoredFormatError)) throw error;
      throw new UnreadableSessionExportError(
        `${file.path} is not a readable Hans session export (${error.message}).`,
        { cause: error },
      );
    }
  }
}
