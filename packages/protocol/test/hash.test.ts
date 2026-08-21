import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { _sha256Fallback, EMPTY_HASH, sha256Hex } from '../src/hash.js';

const encoder = new TextEncoder();

function nodeHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('sha256Hex', () => {
  it('matches the published vector for an empty input', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(EMPTY_HASH);
  });

  it('matches the published vector for "abc"', async () => {
    expect(await sha256Hex(encoder.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', async () => {
    const bytes = encoder.encode('hello vault');
    expect(await sha256Hex(bytes.buffer)).toBe(await sha256Hex(bytes));
  });

  it('hashes a view into a larger buffer without including the rest', async () => {
    const backing = encoder.encode('XXXXpayloadYYYY');
    const view = backing.subarray(4, 11);
    expect(new TextDecoder().decode(view)).toBe('payload');
    expect(await sha256Hex(view)).toBe(await sha256Hex(encoder.encode('payload')));
  });
});

describe('pure-JS fallback', () => {
  it('agrees with WebCrypto and with Node across a range of sizes', async () => {
    // Sizes chosen around the 64-byte block boundary and the 55/56-byte point
    // where the length padding spills into an extra block.
    for (const size of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000, 4096]) {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 256;
      const expected = nodeHash(bytes);
      expect(_sha256Fallback(bytes), `fallback at size ${size}`).toBe(expected);
      expect(await sha256Hex(bytes), `webcrypto at size ${size}`).toBe(expected);
    }
  });

  it('handles binary content with high bytes, as attachments contain', async () => {
    const bytes = new Uint8Array(300);
    for (let i = 0; i < bytes.length; i++) bytes[i] = 255 - (i % 256);
    expect(_sha256Fallback(bytes)).toBe(nodeHash(bytes));
    expect(await sha256Hex(bytes)).toBe(nodeHash(bytes));
  });
});
