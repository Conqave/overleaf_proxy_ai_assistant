import { NamedError } from '../../domain/errors';

export class UnknownStoredFormatError extends NamedError {}

export function getFields(value: unknown): Map<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UnknownStoredFormatError('not an object');
  }
  return new Map(Object.entries(value));
}

export function getNonNegativeInteger(fields: Map<string, unknown>, key: string): number {
  const value = fields.get(key);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new UnknownStoredFormatError(`${key} is not a non-negative integer`);
  }
  return value;
}

export function getPositiveInteger(fields: Map<string, unknown>, key: string): number {
  const value = getNonNegativeInteger(fields, key);
  if (value === 0) throw new UnknownStoredFormatError(`${key} is not a line number`);
  return value;
}

export function getStrings(fields: Map<string, unknown>, key: string): readonly string[] {
  return getArray(fields, key).map((line) => {
    if (typeof line !== 'string')
      throw new UnknownStoredFormatError(`${key} holds a non-text line`);
    return line;
  });
}

export function getBoolean(fields: Map<string, unknown>, key: string): boolean {
  const value = fields.get(key);
  if (typeof value !== 'boolean') throw new UnknownStoredFormatError(`${key} is not a boolean`);
  return value;
}

export function getArray(fields: Map<string, unknown>, key: string): readonly unknown[] {
  const value = fields.get(key);
  if (!Array.isArray(value)) throw new UnknownStoredFormatError(`${key} is not a list`);
  return value;
}

export function getString(fields: Map<string, unknown>, key: string): string {
  const value = fields.get(key);
  if (typeof value !== 'string') throw new UnknownStoredFormatError(`${key} is not text`);
  return value;
}
