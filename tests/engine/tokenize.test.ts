import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { buildDetectors, type DetectorConfig } from '../../src/engine/detector.ts';
import { placeholderFor } from '../../src/engine/placeholder.ts';
import { TokenMap } from '../../src/engine/token-map.ts';
import { restoreText, tokenizeText } from '../../src/engine/tokenize.ts';

const KEY = Uint8Array.from(Array(32).keys());
const CUSTOMER_ID: DetectorConfig = {
  kind: 'pattern',
  name: 'customer-id',
  prefix: 'CUST',
  pattern: String.raw`CUST-\d{4,}`,
};
const ACCOUNT: DetectorConfig = {
  kind: 'pattern',
  name: 'account',
  prefix: 'ACCT',
  pattern: String.raw`AC\d{8}`,
};
const SHORT_CUSTOMER: DetectorConfig = { ...CUSTOMER_ID, pattern: String.raw`CUST-\d{4}` };
// \b keeps it from matching digits inside a placeholder's base32 body.
const SEVEN_DIGITS: DetectorConfig = {
  kind: 'pattern',
  name: 'seven-digits',
  prefix: 'NUM',
  pattern: String.raw`\b\d{7}\b`,
};

/** Random text with customer IDs, account numbers and seven-digit runs mixed in. */
const MIXED_TEXT = fc
  .array(
    fc.oneof(
      fc.string(),
      fc.stringMatching(/^CUST-\d{4,6}$/),
      fc.stringMatching(/^AC\d{8}$/),
      fc.stringMatching(/^\d{7}$/),
    ),
  )
  .map((parts) => parts.join(' '));

describe('tokenizeText', () => {
  test('should replace every match with its placeholder and count hits', () => {
    // Assemble
    const map = new TokenMap(KEY);

    // Act
    const result = tokenizeText(
      'orders for CUST-0001 and CUST-0002.',
      buildDetectors([CUSTOMER_ID]),
      map,
    );

    // Assert: the placeholders are A1's independently computed values
    expect(result).toEqual({
      text: 'orders for CUST_ggfrgflzug and CUST_fz4rkcjzqn.',
      hits: { 'pattern:customer-id': 2 },
    });
  });

  test('should leave text without matches unchanged', () => {
    const text = 'nothing confidential here';
    expect(tokenizeText(text, buildDetectors([CUSTOMER_ID]), new TokenMap(KEY))).toEqual({
      text,
      hits: {},
    });
  });

  test('should merge partially overlapping spans so no claimed character is left', () => {
    // Assemble: CUST-\d{4} claims 0-9 and \b\d{7}\b claims 5-12 of the same text
    const map = new TokenMap(KEY);
    const detectors = buildDetectors([SHORT_CUSTOMER, SEVEN_DIGITS]);

    // Act
    const result = tokenizeText('CUST-0001234', detectors, map);

    // Assert: one placeholder for all 12 characters, under the earliest detector
    expect(result.text).toBe(placeholderFor(KEY, 'pattern:customer-id', 'CUST', 'CUST-0001234'));
    expect(result.text).not.toContain('234');
    expect(result.hits).toEqual({ 'pattern:customer-id': 1 });
    expect(restoreText(result.text, map)).toBe('CUST-0001234');
  });

  test('should keep only the outer span when one span contains another', () => {
    // Assemble: \d{4} finds 0001 inside CUST-0001234
    const map = new TokenMap(KEY);
    const inner: DetectorConfig = {
      ...SEVEN_DIGITS,
      name: 'four-digits',
      pattern: String.raw`\d{4}`,
    };

    // Act
    const result = tokenizeText('CUST-0001234', buildDetectors([CUSTOMER_ID, inner]), map);

    // Assert: the outer span keeps its own canonical form
    expect(result.text).toBe(placeholderFor(KEY, 'pattern:customer-id', 'CUST', 'CUST-0001234'));
    expect(result.hits).toEqual({ 'pattern:customer-id': 1 });
  });

  test('should prefer the longer span when two spans start together', () => {
    // Assemble: both start at 0; the shorter detector comes first in the config
    const map = new TokenMap(KEY);
    const short: DetectorConfig = { ...SHORT_CUSTOMER, name: 'short-customer', prefix: 'SCUST' };

    // Act
    const result = tokenizeText('CUST-0001234', buildDetectors([short, CUSTOMER_ID]), map);

    // Assert: the longer span wins, with its own detector and canonical form
    expect(result.text).toBe(placeholderFor(KEY, 'pattern:customer-id', 'CUST', 'CUST-0001234'));
    expect(result.hits).toEqual({ 'pattern:customer-id': 1 });
  });

  test.each([
    [['first', 'second'], 'AAA'],
    [['second', 'first'], 'BBB'],
  ])('should break an exact tie by config order: %j', (order, prefix) => {
    // Assemble: two detectors that claim exactly the same span
    const configs: Record<string, DetectorConfig> = {
      first: { ...CUSTOMER_ID, name: 'first', prefix: 'AAA' },
      second: { ...CUSTOMER_ID, name: 'second', prefix: 'BBB' },
    };
    const detectors = buildDetectors(order.map((name) => configs[name] ?? CUSTOMER_ID));

    // Act
    const { text } = tokenizeText('CUST-0001', detectors, new TokenMap(KEY));

    // Assert
    expect(text.startsWith(`${prefix}_`)).toBe(true);
  });

  test('should give touching spans separate placeholders', () => {
    expect(
      tokenizeText('CUST-0001CUST-0002', buildDetectors([SHORT_CUSTOMER]), new TokenMap(KEY)).text,
    ).toBe('CUST_ggfrgflzugCUST_fz4rkcjzqn');
  });

  test('should give every spelling one placeholder under ignoreCase', () => {
    // Assemble
    const map = new TokenMap(KEY);
    const detectors = buildDetectors([{ ...CUSTOMER_ID, ignoreCase: true }]);

    // Act
    const result = tokenizeText('cust-0001 and CUST-0001', detectors, map);

    // Assert: one placeholder, restored to the first spelling the map saw
    expect(result.text).toBe('CUST_ggfrgflzug and CUST_ggfrgflzug');
    expect(restoreText(result.text, map)).toBe('cust-0001 and cust-0001');
  });

  test('should count hits per detector', () => {
    const result = tokenizeText(
      'CUST-0001 paid from AC12345678',
      buildDetectors([CUSTOMER_ID, ACCOUNT]),
      new TokenMap(KEY),
    );
    expect(result.hits).toEqual({ 'pattern:customer-id': 1, 'pattern:account': 1 });
  });

  test('should leave no value any detector can find (property)', () => {
    const detectors = buildDetectors([CUSTOMER_ID, ACCOUNT, SEVEN_DIGITS]);
    fc.assert(
      fc.property(MIXED_TEXT, (text) => {
        const { text: tokenized } = tokenizeText(text, detectors, new TokenMap(KEY));
        return detectors.every((detector) => detector.find(tokenized).length === 0);
      }),
    );
  });

  test('should tokenize the same text the same way every time (property)', () => {
    const detectors = buildDetectors([CUSTOMER_ID, ACCOUNT, SEVEN_DIGITS]);
    fc.assert(
      fc.property(
        MIXED_TEXT,
        (text) =>
          tokenizeText(text, detectors, new TokenMap(KEY)).text ===
          tokenizeText(text, detectors, new TokenMap(KEY)).text,
      ),
    );
  });
});

describe('restoreText', () => {
  test('should leave a placeholder it never issued as it is', () => {
    expect(restoreText('see CUST_aaaaaaaaaa', new TokenMap(KEY))).toBe('see CUST_aaaaaaaaaa');
  });

  test('should restore a placeholder that follows other capitals', () => {
    // Assemble: the pattern matches inside IDCUST-0001, so the placeholder follows "ID"
    const map = new TokenMap(KEY);
    const { text } = tokenizeText('IDCUST-0001', buildDetectors([CUSTOMER_ID]), map);

    // Act and Assert
    expect(text).toBe('IDCUST_ggfrgflzug');
    expect(restoreText(text, map)).toBe('IDCUST-0001');
  });

  test('should give back the original text after tokenizing (property)', () => {
    const detectors = buildDetectors([CUSTOMER_ID, ACCOUNT, SEVEN_DIGITS]);
    fc.assert(
      fc.property(MIXED_TEXT, (text) => {
        const map = new TokenMap(KEY);
        return restoreText(tokenizeText(text, detectors, map).text, map) === text;
      }),
    );
  });
});
