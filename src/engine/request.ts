import type { Detector } from './detector.ts';
import type { TokenMap } from './token-map.ts';
import { tokenizeText, type Tokenized } from './tokenize.ts';

/** Distinct strings remembered between turns; the least recently used is forgotten first. */
export const MAX_CACHE_ENTRIES = 50_000;

/** Two keys of one object became identical after tokenizing; amygdala stops rather than drop one. */
export class KeyCollisionError extends Error {
  constructor(key: string) {
    // `key` is already tokenized, so the message holds a placeholder, never a value.
    super(`two keys of one object both became ${key}`);
    this.name = 'KeyCollisionError';
  }
}

/** A request with its protected values replaced, and what was found and left alone. */
export interface TokenizedRequest {
  readonly body: unknown;
  readonly hits: Readonly<Record<string, number>>;
  readonly images: number;
  readonly documents: number;
}

interface Tally {
  readonly hits: Record<string, number>;
  images: number;
  documents: number;
}

// Signed by the API: changing one is rejected with a 400, and Claude wrote them from placeholders.
const SIGNED_BLOCKS = new Set(['thinking', 'redacted_thinking']);

/**
 * Tokenizes every string value and object key in a parsed request, except signed thinking blocks,
 * `signature` values and base64 `data`. Fields it doesn't recognize are scanned, so a new field can
 * never carry a value out unscanned.
 */
export class RequestTokenizer {
  readonly #detectors: readonly Detector[];
  readonly #map: TokenMap;
  readonly #maxEntries: number;
  readonly #cache = new Map<string, Tokenized>();

  constructor(detectors: readonly Detector[], map: TokenMap, maxEntries = MAX_CACHE_ENTRIES) {
    this.#detectors = detectors;
    this.#map = map;
    this.#maxEntries = maxEntries;
  }

  tokenize(body: unknown): TokenizedRequest {
    const tally: Tally = { hits: {}, images: 0, documents: 0 };
    const tokenized = this.#walk(body, tally);
    return { body: tokenized, hits: tally.hits, images: tally.images, documents: tally.documents };
  }

  #text(value: string, tally: Tally): string {
    let result = this.#cache.get(value);
    if (result === undefined) {
      result = tokenizeText(value, this.#detectors, this.#map);
      this.#cache.set(value, result);
      if (this.#cache.size > this.#maxEntries) {
        // A Map iterates in insertion order, so the first key is the least recently used.
        for (const oldest of this.#cache.keys()) {
          this.#cache.delete(oldest);
          break;
        }
      }
    } else {
      this.#cache.delete(value);
      this.#cache.set(value, result);
    }
    for (const [name, count] of Object.entries(result.hits)) {
      tally.hits[name] = (tally.hits[name] ?? 0) + count;
    }
    return result.text;
  }

  #walk(value: unknown, tally: Tally): unknown {
    if (typeof value === 'string') return this.#text(value, tally);
    if (Array.isArray(value)) return value.map((item) => this.#walk(item, tally));
    if (typeof value !== 'object' || value === null) return value;
    const record = value as Record<string, unknown>;
    if (typeof record.type === 'string' && SIGNED_BLOCKS.has(record.type)) return value;
    const base64 = record.type === 'base64' && typeof record.data === 'string';
    if (base64) {
      const mediaType = typeof record.media_type === 'string' ? record.media_type : '';
      if (mediaType.startsWith('image/')) tally.images++;
      else tally.documents++;
    }
    const entries: [string, unknown][] = [];
    const keys = new Set<string>();
    for (const [key, item] of Object.entries(record)) {
      const tokenizedKey = this.#text(key, tally);
      if (keys.has(tokenizedKey)) throw new KeyCollisionError(tokenizedKey);
      keys.add(tokenizedKey);
      const untouched = key === 'signature' || (base64 && key === 'data');
      entries.push([tokenizedKey, untouched ? item : this.#walk(item, tally)]);
    }
    // fromEntries defines own keys, so "__proto__" stays a key instead of setting the prototype.
    return Object.fromEntries(entries);
  }
}
