import { describe, expect, test } from 'vitest';
import { buildDetectors, type DetectorConfig } from '../../src/engine/detector.ts';

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

describe('buildDetectors', () => {
  test('should build one detector per config entry, in order, named <kind>:<name>', () => {
    // Act
    const detectors = buildDetectors([CUSTOMER_ID, ACCOUNT]);

    // Assert
    expect(detectors.map((d) => [d.name, d.prefix])).toEqual([
      ['pattern:customer-id', 'CUST'],
      ['pattern:account', 'ACCT'],
    ]);
    expect(detectors[1]?.find('AC12345678')).toEqual([
      { start: 0, end: 10, canonical: 'AC12345678' },
    ]);
  });

  test.each(['phrases', 'toString', '__proto__'])(
    'should reject an unknown detector kind: %s',
    (kind) => {
      // Assemble: config is read from a file, so the types can't promise its kind
      const config = { ...CUSTOMER_ID, kind } as unknown as DetectorConfig;

      // Act and Assert
      expect(() => buildDetectors([config])).toThrow(`unknown detector kind "${kind}"`);
    },
  );

  test('should reject a repeated detector name', () => {
    expect(() => buildDetectors([CUSTOMER_ID, { ...ACCOUNT, name: 'customer-id' }])).toThrow(
      'duplicate detector name "customer-id"',
    );
  });

  test('should reject a repeated prefix', () => {
    expect(() => buildDetectors([CUSTOMER_ID, { ...ACCOUNT, prefix: 'CUST' }])).toThrow(
      'duplicate prefix "CUST"',
    );
  });

  test.each(['Customer', 'a b', '', 'x\0y', '-lead', 'trail-', 'double--hyphen'])(
    'should reject the detector name %j',
    (name) => {
      expect(() => buildDetectors([{ ...CUSTOMER_ID, name }])).toThrow(
        'detector name must be lowercase letters, digits and hyphens',
      );
    },
  );

  test('should reject a bad prefix with the shared prefix message', () => {
    expect(() => buildDetectors([{ ...CUSTOMER_ID, prefix: 'cust' }])).toThrow(
      'prefix must be 2-10 uppercase letters or digits, starting with a letter',
    );
  });
});
