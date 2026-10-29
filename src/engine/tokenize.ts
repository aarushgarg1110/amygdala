import type { Detector } from './detector.ts';
import type { TokenMap } from './token-map.ts';

/** A string with its protected values replaced, and how many each detector replaced. */
export interface Tokenized {
  readonly text: string;
  readonly hits: Readonly<Record<string, number>>;
}

interface Claim {
  start: number;
  end: number;
  readonly canonical: string;
  readonly detector: Detector;
  /** False once the claim grew to cover another detector's overlapping span. */
  exact: boolean;
}

// Uppercase letters or digits, then "_" and exactly 10 base32 characters. The run before "_" can be
// longer than the prefix when the original value followed other capitals ("IDCUST-0001").
const PLACEHOLDER_CANDIDATE = /([A-Z0-9]{2,})_([a-z2-7]{10})/g;
const MAX_PREFIX = 10;

/**
 * Spans from every detector, merged where they overlap so that no character a detector claimed is
 * left in the text: "earliest start wins" would send the tail of the losing span out in the clear.
 */
function claimsIn(text: string, detectors: readonly Detector[]): Claim[] {
  const spans = detectors.flatMap((detector) =>
    detector.find(text).map((span) => ({ ...span, detector, exact: true })),
  );
  // Earliest start, then longest. The sort is stable, so an exact tie keeps config order.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Claim[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last === undefined || span.start >= last.end) {
      merged.push(span);
    } else if (span.end > last.end) {
      last.end = span.end;
      last.exact = false;
    }
  }
  return merged;
}

/** `text` with every protected value replaced by its placeholder. */
export function tokenizeText(
  text: string,
  detectors: readonly Detector[],
  map: TokenMap,
): Tokenized {
  const claims = claimsIn(text, detectors);
  if (claims.length === 0) return { text, hits: {} };
  const hits: Record<string, number> = {};
  let out = '';
  let cursor = 0;
  for (const claim of claims) {
    const original = text.slice(claim.start, claim.end);
    const canonical = claim.exact ? claim.canonical : original;
    out += text.slice(cursor, claim.start);
    out += map.issue(claim.detector.name, claim.detector.prefix, canonical, original);
    hits[claim.detector.name] = (hits[claim.detector.name] ?? 0) + 1;
    cursor = claim.end;
  }
  return { text: out + text.slice(cursor), hits };
}

/** `text` with every placeholder `map` issued replaced by its original; anything else untouched. */
export function restoreText(text: string, map: TokenMap): string {
  return text.replace(PLACEHOLDER_CANDIDATE, (match, run: string, body: string) => {
    // Try the longest prefix first, down to two characters. Only placeholders the map issued are
    // found, so a candidate that merely looks like one is left alone.
    for (let length = Math.min(run.length, MAX_PREFIX); length >= 2; length--) {
      const prefix = run.slice(run.length - length);
      const original = map.original(`${prefix}_${body}`);
      if (original !== undefined) return run.slice(0, run.length - length) + original;
    }
    return match;
  });
}
