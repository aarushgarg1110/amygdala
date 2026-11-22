import { describe, test } from 'vitest';

describe('createScrubber', () => {
  test.todo('should replace every protected value in a model request with one placeholder');
  test.todo('should send a model request with no protected value as its original bytes');
  test.todo('should tokenize a token-count request like a model request');
  test.todo('should leave image and document data untouched and count them');
  test.todo("should block a request holding amygdala's own key");
  test.todo("should block a model request whose body isn't JSON");
  test.todo('should block a body over the size limit without reading the rest');
  test.todo('should block a compressed body');
  test.todo('should block a placeholder or key collision');
  test.todo('should block a protected value on any other path or intercept host');
  test.todo('should forward a request on another path with no protected value byte for byte');
  test.todo("should block a body that isn't JSON on another path");
  test.todo('should block a protected value in the URL, decoded or not');
  test.todo('should block a protected value in a header');
  test.todo('should treat a model path on another host as another path');
  test.todo('should not connect upstream until the whole body has arrived');
  test.todo('should send nothing when the client leaves mid-body');
  test.todo('should report whether a model request carries a thread field');
  test.todo('should never put a value or the key in a block message or a decision');
});
