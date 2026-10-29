import { describe, test } from 'vitest';

describe('tokenizeText', () => {
  test.todo('should replace every match with its placeholder and count hits');
  test.todo('should leave text without matches unchanged');
  test.todo('should merge partially overlapping spans so no claimed character is left');
  test.todo('should keep only the outer span when one span contains another');
  test.todo('should give touching spans separate placeholders');
  test.todo('should give every spelling one placeholder under ignoreCase');
  test.todo('should count hits per detector');
  test.todo('should leave no value any detector can find (property)');
  test.todo('should tokenize the same text the same way every time (property)');
});

describe('restoreText', () => {
  test.todo('should leave a placeholder it never issued as it is');
  test.todo('should give back the original text after tokenizing (property)');
});
