import { describe, test } from 'vitest';

describe('pattern detector', () => {
  test.todo('should find every match with its position and canonical form');
  test.todo('should find nothing in text without a match');
  test.todo('should find matches at the very start and the very end of the text');
  test.todo('should give every letter case one canonical form under ignoreCase');
  test.todo('should be case-sensitive by default');
  test.todo('should report UTF-16 positions after an emoji');
  test.todo('should reject an invalid pattern, naming the detector');
  test.todo('should reject a pattern that matches the empty string');
  test.todo('should return spans inside the text, matching, sorted and not overlapping (property)');
  test.todo('should give random letter case the same canonical form (property)');
});
