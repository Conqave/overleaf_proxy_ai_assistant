const VERSION_BYTE = 6;
const VARIANT_BYTE = 8;

export function createUuid(crypto: Pick<Crypto, 'getRandomValues'>): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const view = new DataView(bytes.buffer);
  view.setUint8(VERSION_BYTE, (view.getUint8(VERSION_BYTE) & 0x0f) | 0x40);
  view.setUint8(VARIANT_BYTE, (view.getUint8(VARIANT_BYTE) & 0x3f) | 0x80);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
