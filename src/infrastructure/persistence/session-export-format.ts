import type { SessionExport } from '../../domain/session-export';
import { parseSessionContent } from './stored-conversation-format';
import {
  getFields,
  getNonNegativeInteger,
  getString,
  UnknownStoredFormatError,
} from './stored-fields';

export const SESSION_EXPORT_FORMAT = 'hans-session-export/1';
const INDENT = 2;

export function serializeSessionExport(exported: SessionExport): string {
  const document = {
    format: SESSION_EXPORT_FORMAT,
    projectId: exported.projectId,
    exportedBy: exported.exportedBy,
    exportedAt: exported.exportedAt,
    session: exported.session,
  };
  return `${JSON.stringify(document, null, INDENT)}\n`;
}

export function parseSessionExport(text: string): SessionExport {
  const fields = getFields(parseJson(text));
  if (fields.get('format') !== SESSION_EXPORT_FORMAT) {
    throw new UnknownStoredFormatError(`format is not ${SESSION_EXPORT_FORMAT}`);
  }
  return {
    projectId: getIdentifier(fields, 'projectId'),
    exportedBy: getIdentifier(fields, 'exportedBy'),
    exportedAt: getNonNegativeInteger(fields, 'exportedAt'),
    session: parseSessionContent(fields.get('session')),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new UnknownStoredFormatError('not JSON', { cause: error });
  }
}

function getIdentifier(fields: Map<string, unknown>, key: string): string {
  const value = getString(fields, key);
  if (value === '') throw new UnknownStoredFormatError(`${key} is empty`);
  return value;
}
