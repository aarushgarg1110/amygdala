import { randomBytes } from 'node:crypto';
import type { SecretStore } from './keychain.ts';
import { MIN_KEY_BYTES } from './engine/placeholder.ts';

// 32 bytes as lower-case hex: nothing to escape, nothing to misread when copied by hand.
const KEY_HEX = new RegExp(`^[0-9a-f]{${String(MIN_KEY_BYTES * 2)}}$`);

/** The key can't be used; the message never holds it. */
export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyError';
  }
}

/** A fresh key from the operating system's random source, as stored in the Keychain. */
export function newKeyHex(): string {
  return randomBytes(MIN_KEY_BYTES).toString('hex');
}

/** The key for the data folder `dir`. Refuses a damaged one: it would change every placeholder. */
export function loadKey(dir: string, store: SecretStore): Uint8Array {
  const stored = store.read(dir);
  if (stored === undefined) throw new KeyError(`no key for ${dir}: run \`amygdala init\``);
  if (!KEY_HEX.test(stored)) {
    throw new KeyError(
      `the key for ${dir} is damaged (not ${String(MIN_KEY_BYTES * 2)} lower-case hex characters)`,
    );
  }
  return Uint8Array.from(Buffer.from(stored, 'hex'));
}
