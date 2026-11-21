import { describe, test } from 'vitest';

describe('own-key detector', () => {
  test.todo('should count the key found in a request');
  test.todo('should find hex in any letter case');
  test.todo('should find base64 and base64url, padded and unpadded');
  test.todo('should find URL-encoded base64 in either percent case');
  test.todo('should find JSON-escaped base64');
  test.todo('should cover exactly the key inside other text');
  test.todo('should give every occurrence one placeholder');
  test.todo('should not find another key or a partial key');
  test.todo('should refuse a key shorter than 32 bytes');
  test.todo("should still count the key inside another detector's longer match");
  test.todo('should derive the placeholder from a constant, not from the key');
});
