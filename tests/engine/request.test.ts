import { describe, test } from 'vitest';

describe('RequestTokenizer', () => {
  test.todo('should replace every protected value in every scanned place');
  test.todo('should leave a thinking block untouched');
  test.todo('should leave a redacted_thinking block untouched');
  test.todo('should leave a signature untouched wherever it is');
  test.todo('should leave base64 data untouched and count images and documents');
  test.todo('should tokenize object keys');
  test.todo('should throw KeyCollisionError when two keys become one');
  test.todo('should keep a __proto__ key as an ordinary key');
  test.todo('should leave numbers, booleans and null unchanged');
  test.todo('should scan fields it does not know about');
  test.todo('should not call detectors again for strings it has seen');
  test.todo('should evict the least recently used string past the cache limit');
  test.todo('should sum hits across strings');
  test.todo('should give the original back after restoring every string (property)');
  test.todo('should leave nothing any detector can find (property)');
});
