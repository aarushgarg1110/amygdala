import { describe, test } from 'vitest';

describe('recorded Claude Code fixtures', () => {
  test.todo(
    'should parse every request as JSON and every response as a stream ending in message_stop',
  );
  test.todo('should contain no home directory paths');
  test.todo('should contain no email address outside example.com');
  test.todo('should keep system and tool text under the length cap');
  test.todo('should contain none of the markers in AMYGDALA_FIXTURE_FORBIDDEN');
  test.todo('should let RequestTokenizer replace every synthetic customer ID');
});

describe('scrubFixture', () => {
  test.todo('should replace system prompt and tool description text, keeping the block structure');
  test.todo('should replace personal markers in requests and response streams');
  test.todo('should give the same output when run twice');
});
