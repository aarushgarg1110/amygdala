import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  createPatternDetector,
  type PatternConfig,
} from '../../../src/engine/detectors/pattern.ts';

const CUSTOMER_ID: PatternConfig = {
  kind: 'pattern',
  name: 'customer-id',
  prefix: 'CUST',
  pattern: String.raw`CUST-\d{4,}`,
};
const WHOLE_ID = /^CUST-\d{4,}$/i;

describe('pattern detector', () => {
  test('should find every match with its position and canonical form', () => {
    // Assemble
    const detector = createPatternDetector(CUSTOMER_ID);

    // Act
    const spans = detector.find('orders for CUST-0001 and CUST-0002.');

    // Assert
    expect(detector.name).toBe('pattern:customer-id');
    expect(spans).toEqual([
      { start: 11, end: 20, canonical: 'CUST-0001' },
      { start: 25, end: 34, canonical: 'CUST-0002' },
    ]);
  });

  test('should find nothing in text without a match', () => {
    expect(
      createPatternDetector(CUSTOMER_ID).find('no customer here, CUST-12 is too short'),
    ).toEqual([]);
  });

  test('should find matches at the very start and the very end of the text', () => {
    // Assemble
    const text = 'CUST-0001 then CUST-0002';

    // Act
    const spans = createPatternDetector(CUSTOMER_ID).find(text);

    // Assert
    expect(spans.at(0)?.start).toBe(0);
    expect(spans.at(-1)?.end).toBe(text.length);
  });

  test('should give every letter case one canonical form under ignoreCase', () => {
    // Assemble
    const detector = createPatternDetector({ ...CUSTOMER_ID, ignoreCase: true });

    // Act
    const spans = detector.find('cust-0001 and CUST-0001');

    // Assert
    expect(spans.map((span) => span.canonical)).toEqual(['CUST-0001', 'CUST-0001']);
  });

  test('should be case-sensitive by default', () => {
    expect(createPatternDetector(CUSTOMER_ID).find('cust-0001')).toEqual([]);
  });

  test('should report UTF-16 positions after an emoji', () => {
    // Assemble: the emoji is two UTF-16 units, the same units String.slice counts
    const text = '😀 CUST-0001';

    // Act
    const [span] = createPatternDetector(CUSTOMER_ID).find(text);

    // Assert
    expect(span).toEqual({ start: 3, end: 12, canonical: 'CUST-0001' });
    expect(text.slice(3, 12)).toBe('CUST-0001');
  });

  test('should reject an invalid pattern, naming the detector', () => {
    expect(() => createPatternDetector({ ...CUSTOMER_ID, pattern: '(' })).toThrow(
      /^detector "customer-id": invalid pattern: /,
    );
  });

  test.each(['x*', 'CUST|', '(?:)'])(
    'should reject a pattern that matches the empty string: %s',
    (pattern) => {
      expect(() => createPatternDetector({ ...CUSTOMER_ID, pattern })).toThrow(
        'detector "customer-id": pattern must not match an empty string',
      );
    },
  );

  test('should never report an empty span, even for a lookahead-only pattern', () => {
    expect(createPatternDetector({ ...CUSTOMER_ID, pattern: '(?=CUST)' }).find('CUST')).toEqual([]);
  });

  test('should return spans inside the text, matching, sorted and not overlapping (property)', () => {
    const detector = createPatternDetector(CUSTOMER_ID);
    const text = fc
      .array(fc.oneof(fc.string(), fc.stringMatching(/^CUST-\d{4,6}$/)))
      .map((parts) => parts.join(' '));
    fc.assert(
      fc.property(text, (value) => {
        const spans = detector.find(value);
        return spans.every(
          (span, index) =>
            span.start >= 0 &&
            span.start < span.end &&
            span.end <= value.length &&
            WHOLE_ID.test(value.slice(span.start, span.end)) &&
            (index === 0 || (spans[index - 1]?.end ?? 0) <= span.start),
        );
      }),
    );
  });

  test('should give random letter case the same canonical form (property)', () => {
    const detector = createPatternDetector({ ...CUSTOMER_ID, ignoreCase: true });
    const spelled = fc
      .tuple(fc.stringMatching(/^\d{4,6}$/), fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }))
      .map(([digits, upper]) => ({
        id: `CUST-${digits}`,
        written:
          ['c', 'u', 's', 't'].map((c, i) => (upper[i] ? c.toUpperCase() : c)).join('') +
          `-${digits}`,
      }));
    fc.assert(
      fc.property(spelled, ({ id, written }) => detector.find(written).at(0)?.canonical === id),
    );
  });
});
