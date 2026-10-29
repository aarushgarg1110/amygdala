import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { PLACEHOLDER_PATTERN, placeholderFor } from '../../src/engine/placeholder.ts';

// Synthetic key 0x00..0x1f. Every expected placeholder below was computed with Python's hmac and
// base64 modules, not by this code, so these tests also pin the algorithm: if a change ever alters
// placeholders, teammates' placeholders would stop matching, and these fail first.
const KEY = Uint8Array.from(Array(32).keys());
const OTHER_KEY = Uint8Array.from(Array(32).keys(), (index) => index + 1);
const DETECTOR = 'pattern:customer-id';

describe('placeholderFor', () => {
  test.each([
    ['CUST-0001', 'CUST_ggfrgflzug'],
    ['CUST-0002', 'CUST_fz4rkcjzqn'],
  ])('should match the independently computed value for %s', (value, expected) => {
    // Act
    const placeholder = placeholderFor(KEY, DETECTOR, 'CUST', value);

    // Assert
    expect(placeholder).toBe(expected);
  });

  test('should give a different placeholder for the same value under another detector', () => {
    expect(placeholderFor(KEY, 'pattern:other', 'CUST', 'CUST-0001')).toBe('CUST_oea3mwsdwy');
  });

  test('should give a different placeholder for the same value under another key', () => {
    expect(placeholderFor(OTHER_KEY, DETECTOR, 'CUST', 'CUST-0001')).toBe('CUST_gewce63z2r');
  });

  test.each([0, 31])('should reject a key of %i bytes', (bytes) => {
    // Assemble
    const shortKey = new Uint8Array(bytes);

    // Act and Assert
    expect(() => placeholderFor(shortKey, DETECTOR, 'CUST', 'CUST-0001')).toThrow(
      'HMAC key must be at least 32 bytes',
    );
  });

  test.each(['cust', 'C', 'CUST_', '', 'ELEVENCHARS', '1CUST'])(
    'should reject the prefix %j',
    (prefix) => {
      expect(() => placeholderFor(KEY, DETECTOR, prefix, 'CUST-0001')).toThrow(
        'prefix must be 2-10 uppercase letters or digits, starting with a letter',
      );
    },
  );

  test.each(['CU', 'ABCDEFGHIJ', 'MOL2'])('should accept the prefix %j', (prefix) => {
    expect(placeholderFor(KEY, DETECTOR, prefix, 'CUST-0001')).toMatch(PLACEHOLDER_PATTERN);
  });

  test('should reject an empty canonical value', () => {
    expect(() => placeholderFor(KEY, DETECTOR, 'CUST', '')).toThrow(
      'canonical value must not be empty',
    );
  });

  test('should always produce PREFIX_ followed by 10 base32 characters (property)', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z][A-Z0-9]{1,9}$/),
        fc.string({ minLength: 1 }),
        (prefix, canonical) =>
          PLACEHOLDER_PATTERN.test(placeholderFor(KEY, DETECTOR, prefix, canonical)),
      ),
    );
  });
});
