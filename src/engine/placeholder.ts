import { createHmac } from 'node:crypto';

/** Base32 characters kept from the HMAC: 10 characters carry 50 bits. */
export const TOKEN_CHARS = 10;
/** The shortest HMAC key accepted, in bytes. */
export const MIN_KEY_BYTES = 32;
/** What every placeholder looks like; the restorer relies on this shape. */
export const PLACEHOLDER_PATTERN = /^[A-Z][A-Z0-9]{1,9}_[a-z2-7]{10}$/;

const PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
// 7 bytes = 56 bits, enough for TOKEN_CHARS * 5 = 50.
const DIGEST_BYTES_USED = 7;

/**
 * RFC 4648 base32, lowercase, full 5-bit groups only: trailing bits that don't fill a character are
 * dropped, which is all a placeholder needs.
 */
function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    // At most 4 leftover bits plus 8 new ones are ever needed, so 12 bits are kept.
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32.charAt((buffer >>> bits) & 31);
    }
  }
  return out;
}

/**
 * The placeholder for a protected value: PREFIX_ plus the first TOKEN_CHARS base32 characters of
 * HMAC-SHA256(key, detector + "\0" + canonical). Keyed, so holding a placeholder doesn't let anyone
 * test a guess; the detector name in front keeps two detectors from ever sharing a placeholder.
 */
export function placeholderFor(
  key: Uint8Array,
  detector: string,
  prefix: string,
  canonical: string,
): string {
  if (key.length < MIN_KEY_BYTES) {
    throw new Error(`HMAC key must be at least ${String(MIN_KEY_BYTES)} bytes`);
  }
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error('prefix must be 2-10 uppercase letters or digits, starting with a letter');
  }
  if (canonical === '') throw new Error('canonical value must not be empty');
  const digest = createHmac('sha256', key).update(`${detector}\0${canonical}`).digest();
  return `${prefix}_${base32(digest.subarray(0, DIGEST_BYTES_USED)).slice(0, TOKEN_CHARS)}`;
}
