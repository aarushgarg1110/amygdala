import { inspect } from 'node:util';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { PlaceholderCollisionError, TokenMap } from '../../src/engine/token-map.ts';

const KEY = Uint8Array.from(Array(32).keys());
const DETECTOR = 'pattern:customer-id';
const SAME_PLACEHOLDER = () => 'CUST_aaaaaaaaaa';

describe('TokenMap', () => {
  test('should return the original value for an issued placeholder', () => {
    // Assemble
    const map = new TokenMap(KEY);

    // Act
    const placeholder = map.issue(DETECTOR, 'CUST', 'CUST-0001', 'CUST-0001');

    // Assert
    expect(placeholder).toBe('CUST_ggfrgflzug');
    expect(map.original(placeholder)).toBe('CUST-0001');
  });

  test('should keep the first spelling when the same canonical value is issued again', () => {
    // Assemble
    const map = new TokenMap(KEY);
    const first = map.issue(DETECTOR, 'CUST', 'CUST-0001', 'cust-0001');

    // Act
    const second = map.issue(DETECTOR, 'CUST', 'CUST-0001', 'CUST-0001');

    // Assert
    expect(second).toBe(first);
    expect(map.original(first)).toBe('cust-0001');
    expect(map.size).toBe(1);
  });

  test('should return undefined for a placeholder it never issued', () => {
    expect(new TokenMap(KEY).original('CUST_aaaaaaaaaa')).toBeUndefined();
  });

  test.each([
    ['another value', DETECTOR, 'CUST-0002'],
    ['the same value under another detector', 'pattern:other', 'CUST-0001'],
  ])(
    'should throw PlaceholderCollisionError when %s gets the same placeholder',
    (description, detector, canonical) => {
      // Assemble
      const map = new TokenMap(KEY, SAME_PLACEHOLDER);
      map.issue(DETECTOR, 'CUST', 'CUST-0001', 'CUST-0001');

      // Act and Assert: fails closed, and the message names no value
      expect(() => map.issue(detector, 'CUST', canonical, canonical)).toThrow(
        PlaceholderCollisionError,
      );
      expect(() => map.issue(detector, 'CUST', canonical, canonical)).toThrow(
        /^two different values produced the placeholder CUST_aaaaaaaaaa$/,
      );
    },
  );

  test('should never show values when inspected, serialized or converted to a string', () => {
    // Assemble
    const map = new TokenMap(KEY);
    map.issue(DETECTOR, 'CUST', 'CUST-0001', 'CUST-0001');
    map.issue(DETECTOR, 'CUST', 'CUST-0002', 'CUST-0002');

    // Act
    const shown = [
      inspect(map),
      JSON.stringify(map),
      String(map),
      inspect(map, { showHidden: true, depth: 10 }),
    ];

    // Assert
    expect(shown.slice(0, 3)).toEqual([
      'TokenMap { size: 2 }',
      '{"size":2}',
      '[TokenMap: 2 entries]',
    ]);
    for (const text of shown) expect(text).not.toContain('CUST-000');
  });

  test('should restore any issued value (property)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), (canonical, original) => {
        const map = new TokenMap(KEY);
        return map.original(map.issue(DETECTOR, 'CUST', canonical, original)) === original;
      }),
    );
  });

  test('should issue the same placeholder for the same value (property)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (canonical) => {
        const issueOnce = () => new TokenMap(KEY).issue(DETECTOR, 'CUST', canonical, canonical);
        return issueOnce() === issueOnce();
      }),
    );
  });
});
