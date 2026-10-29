import { describe, test } from 'vitest';

describe('StreamParser', () => {
  test.todo('should split each recorded stream into its events and give back the same bytes');
  test.todo('should give the same events wherever a chunk boundary falls');
  test.todo('should give the same events for any chunk sizes');
  test.todo("should tag deltas with their block's type and tool name");
  test.todo('should leave a delta whose block never started without a block');
  test.todo('should pass an unknown event through unchanged');
  test.todo("should pass data that isn't JSON through unchanged");
  test.todo('should read CRLF and CR line endings the same as LF');
  test.todo('should ignore comment lines and join several data lines');
  test.todo('should return a last event that has no blank line from end()');
  test.todo('should keep extra blank lines without making events');
});

describe('formatEvent', () => {
  test.todo('should write an event that reads back to the same name and data');
});
