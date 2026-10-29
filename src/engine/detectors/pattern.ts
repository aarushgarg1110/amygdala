import type { Detector, Span } from '../detector.ts';

/** A `kind = "pattern"` entry: protected values are whatever the regular expression matches. */
export interface PatternConfig {
  readonly kind: 'pattern';
  readonly name: string;
  readonly prefix: string;
  readonly pattern: string;
  /** Match regardless of case; the canonical form is then upper-cased, so spellings share one. */
  readonly ignoreCase?: boolean;
}

export function createPatternDetector(config: PatternConfig): Detector {
  const ignoreCase = config.ignoreCase === true;
  const flags = ignoreCase ? 'iu' : 'u';
  let probe: RegExp;
  try {
    probe = new RegExp(config.pattern, flags);
  } catch (error) {
    // The RegExp constructor only ever throws SyntaxError.
    const reason = (error as SyntaxError).message;
    throw new Error(`detector "${config.name}": invalid pattern: ${reason}`, { cause: error });
  }
  if (probe.test('')) {
    throw new Error(`detector "${config.name}": pattern must not match an empty string`);
  }
  // matchAll copies the regex, so one global instance is safe to reuse across calls.
  const regex = new RegExp(config.pattern, `g${flags}`);

  return {
    name: `pattern:${config.name}`,
    prefix: config.prefix,
    find(text: string): readonly Span[] {
      const spans: Span[] = [];
      for (const match of text.matchAll(regex)) {
        const value = match[0];
        // A pattern that matches nothing only in context (a lookahead) still yields no span.
        if (value === '') continue;
        spans.push({
          start: match.index,
          end: match.index + value.length,
          canonical: ignoreCase ? value.toUpperCase() : value,
        });
      }
      return spans;
    },
  };
}
