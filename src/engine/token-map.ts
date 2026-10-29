import { inspect } from 'node:util';
import { placeholderFor } from './placeholder.ts';

/** Two different values produced one placeholder; amygdala stops rather than mix them up. */
export class PlaceholderCollisionError extends Error {
  constructor(placeholder: string) {
    // The message names the placeholder only: the values it would mix up are confidential.
    super(`two different values produced the placeholder ${placeholder}`);
    this.name = 'PlaceholderCollisionError';
  }
}

type Derive = typeof placeholderFor;

interface Entry {
  readonly detector: string;
  readonly canonical: string;
  readonly original: string;
}

/** Placeholder -> the real value it stands for. Memory only; it never prints its values. */
export class TokenMap {
  readonly #entries = new Map<string, Entry>();
  readonly #key: Uint8Array;
  readonly #derive: Derive;

  constructor(key: Uint8Array, derive: Derive = placeholderFor) {
    this.#key = key;
    this.#derive = derive;
  }

  /** The placeholder for `original`, whose detector-specific canonical form is `canonical`. */
  issue(detector: string, prefix: string, canonical: string, original: string): string {
    const placeholder = this.#derive(this.#key, detector, prefix, canonical);
    const existing = this.#entries.get(placeholder);
    if (existing === undefined) {
      this.#entries.set(placeholder, { detector, canonical, original });
    } else if (existing.detector !== detector || existing.canonical !== canonical) {
      throw new PlaceholderCollisionError(placeholder);
    }
    return placeholder;
  }

  /** The first spelling issued for `placeholder`, or undefined if this map never issued it. */
  original(placeholder: string): string | undefined {
    return this.#entries.get(placeholder)?.original;
  }

  get size(): number {
    return this.#entries.size;
  }

  toJSON(): { size: number } {
    return { size: this.size };
  }

  toString(): string {
    return `[TokenMap: ${String(this.size)} entries]`;
  }

  [inspect.custom](): string {
    return `TokenMap { size: ${String(this.size)} }`;
  }
}
