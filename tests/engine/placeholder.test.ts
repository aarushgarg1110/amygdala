import { describe, test } from 'vitest';

describe('placeholderFor', () => {
  test.todo('should match the independently computed value for CUST-0001 and CUST-0002');
  test.todo('should give a different placeholder for the same value under another detector');
  test.todo('should give a different placeholder for the same value under another key');
  test.todo('should reject a key shorter than 32 bytes');
  test.todo('should reject a prefix that is not 2-10 uppercase letters or digits');
  test.todo('should reject an empty canonical value');
  test.todo('should always produce PREFIX_ followed by 10 base32 characters (property)');
});
