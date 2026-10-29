import { createPatternDetector, type PatternConfig } from './detectors/pattern.ts';
import { assertPrefix } from './placeholder.ts';

/** Where a protected value sits in a string, and the form its placeholder is derived from. */
export interface Span {
  readonly start: number;
  readonly end: number;
  readonly canonical: string;
}

/** Finds protected values in text. Each detector decides for itself what counts. */
export interface Detector {
  /** `<kind>:<name>`. It goes into the placeholder's HMAC, so it must never change. */
  readonly name: string;
  readonly prefix: string;
  /** Spans sorted by start, never overlapping. */
  find(text: string): readonly Span[];
}

/** One `[[detectors]]` entry of the config. New kinds join this union and FACTORIES. */
export type DetectorConfig = PatternConfig;

type Factory<C> = (config: C) => Detector;

// One factory per kind: the mapped type makes a kind without a factory a compile error.
const FACTORIES: {
  readonly [K in DetectorConfig['kind']]: Factory<Extract<DetectorConfig, { kind: K }>>;
} = { pattern: createPatternDetector };

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Detectors for the config's entries, in order. Throws on the first entry that can't be built. */
export function buildDetectors(configs: readonly DetectorConfig[]): readonly Detector[] {
  const names = new Set<string>();
  const prefixes = new Set<string>();
  return configs.map((config) => {
    // Config comes from a file, so its kind is checked at run time, not just by the types.
    if (!Object.hasOwn(FACTORIES, config.kind)) {
      throw new Error(`unknown detector kind "${config.kind}"`);
    }
    if (!NAME_PATTERN.test(config.name)) {
      throw new Error('detector name must be lowercase letters, digits and hyphens');
    }
    assertPrefix(config.prefix);
    if (names.has(config.name)) throw new Error(`duplicate detector name "${config.name}"`);
    if (prefixes.has(config.prefix)) throw new Error(`duplicate prefix "${config.prefix}"`);
    names.add(config.name);
    prefixes.add(config.prefix);
    return FACTORIES[config.kind](config);
  });
}
