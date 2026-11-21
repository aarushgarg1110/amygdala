import { describe, expect, test } from 'vitest';
import { KeyError, loadKey, newKeyHex } from '../src/key.ts';
import { MemoryStore } from './memory-store.ts';

const DIR = '/data/amygdala';

describe('loadKey', () => {
  test('should give back the 32 bytes that were stored', () => {
    // Assemble
    const store = new MemoryStore();
    const hex = newKeyHex();
    store.secrets.set(DIR, hex);

    // Act
    const key = loadKey(DIR, store);

    // Assert: 64 lower-case hex characters, fresh each time, decoded to exactly 32 bytes
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(newKeyHex()).not.toBe(hex);
    expect(Buffer.from(key).toString('hex')).toBe(hex);
    expect(key).toHaveLength(32);
  });

  test('should refuse a folder with no key and point to amygdala init', () => {
    expect(() => loadKey(DIR, new MemoryStore())).toThrow(
      new KeyError(`no key for ${DIR}: run \`amygdala init\``),
    );
  });

  test.each([
    ['too short', 'ab12'],
    ['one character short', 'a'.repeat(63)],
    ['one character long', 'a'.repeat(65)],
    ['not hex', 'g'.repeat(64)],
    ['upper-case', 'A'.repeat(64)],
  ])('should refuse a stored key that is short, not hex or upper-case: %s', (label, stored) => {
    // Assemble
    const store = new MemoryStore();
    store.secrets.set(DIR, stored);

    // Act
    let message = '';
    try {
      loadKey(DIR, store);
    } catch (error) {
      expect(error).toBeInstanceOf(KeyError);
      message = (error as Error).message;
    }

    // Assert: refused as damaged, without echoing what was stored
    expect(message).toBe(`the key for ${DIR} is damaged (not 64 lower-case hex characters)`);
    expect(message).not.toContain(stored);
  });
});
