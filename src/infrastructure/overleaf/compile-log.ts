import { DiagnosticLevel, type CompileDiagnostic } from '../../domain/agent-transcript';
import { InvalidProjectPathError } from '../../domain/errors';
import { createProjectPath } from '../../domain/project-file';
import { OverleafStoreContractError } from './overleaf-store';

const LEVEL_GROUPS = [
  ['errors', DiagnosticLevel.Error],
  ['warnings', DiagnosticLevel.Warning],
  ['typesetting', DiagnosticLevel.Typesetting],
] as const;

const PROJECT_FILE_PREFIX = './';

export function readCompileDiagnostics(logEntries: unknown): readonly CompileDiagnostic[] {
  if (typeof logEntries !== 'object' || logEntries === null) {
    throw new OverleafStoreContractError('pdf.logEntries is not an object');
  }
  const entries = new Map<string, unknown>(Object.entries(logEntries));
  return LEVEL_GROUPS.flatMap(([group, level]) => {
    const list = entries.get(group);
    if (!Array.isArray(list)) {
      throw new OverleafStoreContractError(`pdf.logEntries.${group} is not a list`);
    }
    return list.map((entry: unknown) => readDiagnostic(entry, level));
  });
}

function readDiagnostic(entry: unknown, level: DiagnosticLevel): CompileDiagnostic {
  if (typeof entry !== 'object' || entry === null) {
    throw new OverleafStoreContractError('a log entry is not an object');
  }
  if (!('message' in entry) || typeof entry.message !== 'string') {
    throw new OverleafStoreContractError('a log entry has no message');
  }
  const path = readPath('file' in entry ? entry.file : undefined);
  const lineNumber = readLineNumber('line' in entry ? entry.line : undefined);
  return {
    level,
    message: entry.message,
    ...(path === undefined ? {} : { path }),
    ...(lineNumber === undefined ? {} : { lineNumber }),
  };
}

function readPath(file: unknown): string | undefined {
  if (file === undefined || file === null || file === '') return undefined;
  if (typeof file !== 'string')
    throw new OverleafStoreContractError('a log entry file is not text');
  if (file.startsWith('/')) return undefined;
  const relative = file.startsWith(PROJECT_FILE_PREFIX)
    ? file.slice(PROJECT_FILE_PREFIX.length)
    : file;
  try {
    return createProjectPath(relative);
  } catch (error) {
    if (!(error instanceof InvalidProjectPathError)) throw error;
    throw new OverleafStoreContractError(`log entry file ${JSON.stringify(file)} is no path`, {
      cause: error,
    });
  }
}

function readLineNumber(line: unknown): number | undefined {
  if (line === undefined || line === null || line === '') return undefined;
  const lineNumber = typeof line === 'string' && /^\d+$/.test(line) ? Number(line) : line;
  if (typeof lineNumber !== 'number' || !Number.isInteger(lineNumber) || lineNumber < 1) {
    throw new OverleafStoreContractError(
      `log entry line ${JSON.stringify(line)} is no line number`,
    );
  }
  return lineNumber;
}
