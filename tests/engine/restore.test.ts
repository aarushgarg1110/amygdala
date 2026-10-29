import { describe, test } from 'vitest';

describe('StreamRestorer', () => {
  test.todo('should restore a whole placeholder inside one delta');
  test.todo('should restore a placeholder split across two deltas at every position');
  test.todo('should restore placeholders when every character is its own delta');
  test.todo('should give the same text as restoring the joined stream, for any chunking');
  test.todo("should restore the recorded reply's three IDs across its real chunk boundaries");
  test.todo('should leave text that only looks like a placeholder alone');
  test.todo("should send held text before the block's stop");
  test.todo('should hold back a trailing uppercase run and send it with the next delta');
  test.todo('should hold back at most MAX_HOLDBACK_CHARS');
  test.todo('should forward a delta with nothing to restore byte for byte');
  test.todo('should forward a fully held delta with empty text');
  test.todo('should leave thinking, signatures and tool arguments alone');
  test.todo('should keep hold-back separate per block');
  test.todo('should send held text from end()');
  test.todo('should escape a restored value so the event parses back to it');
});
