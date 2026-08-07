import { describe, expect, it } from 'vitest';
import { createUuid } from '../../../src/infrastructure/browser/uuid';

describe('createUuid', () => {
  it('produces RFC 9562 version 4 UUIDs', () => {
    expect(createUuid(crypto)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('needs only getRandomValues, which browsers offer outside secure contexts too', () => {
    const insecure = { getRandomValues: crypto.getRandomValues.bind(crypto) };
    const ids = new Set(Array.from({ length: 1000 }, () => createUuid(insecure)));
    expect(ids.size).toBe(1000);
  });

  it('sets version and variant bits whatever the random bytes are', () => {
    const constant = (value: number): Pick<Crypto, 'getRandomValues'> => ({
      getRandomValues: (array) => {
        if (array instanceof Uint8Array) array.fill(value);
        return array;
      },
    });
    expect(createUuid(constant(0x00))).toBe('00000000-0000-4000-8000-000000000000');
    expect(createUuid(constant(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });
});
