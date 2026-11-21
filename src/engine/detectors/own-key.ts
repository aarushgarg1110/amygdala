import { Buffer } from 'node:buffer';
import type { Detector, Span } from '../detector.ts';
import { MIN_KEY_BYTES } from '../placeholder.ts';

/** The detector whose hits make B3 block a request. Built from the key itself, never from config. */
export const OWN_KEY_DETECTOR = 'builtin:own-key';
const PREFIX = 'KEY';
// Every encoding gets one placeholder, so a placeholder says nothing about the key or its form.
const CANONICAL = 'own-key';

const escapeRegExp = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/**
 * The text forms of `key` the wire test searches (5.1): hex; base64 and base64url, padded and not;
 * URL-encoded base64; JSON-escaped base64. Longest first, so a padded form is matched whole.
 */
export function ownKeyEncodings(key: Uint8Array): readonly string[] {
  const bytes = Buffer.from(key);
  const base64 = bytes.toString('base64');
  const base64url = bytes.toString('base64url');
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const forms = [
    bytes.toString('hex'),
    base64,
    base64.replace(/=+$/, ''),
    base64url,
    base64url + padding,
    encodeURIComponent(base64),
    base64.replaceAll('/', '\\/'),
  ];
  return [...new Set(forms)].sort((a, b) => b.length - a.length);
}

/** Finds amygdala's own key in any of its text forms, ignoring letter case. */
export function createOwnKeyDetector(key: Uint8Array): Detector {
  if (key.length < MIN_KEY_BYTES) {
    throw new Error(`HMAC key must be at least ${String(MIN_KEY_BYTES)} bytes`);
  }
  const regex = new RegExp(ownKeyEncodings(key).map(escapeRegExp).join('|'), 'gi');
  return {
    name: OWN_KEY_DETECTOR,
    prefix: PREFIX,
    find(text: string): readonly Span[] {
      return [...text.matchAll(regex)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        canonical: CANONICAL,
      }));
    },
  };
}
