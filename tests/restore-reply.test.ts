import { describe, test } from 'vitest';

describe('restoring replies', () => {
  test.todo(
    'should restore a placeholder in streamed text and leave thinking and signatures alone',
  );
  test.todo('should restore a placeholder split across two text deltas');
  test.todo('should stream a restored reply as it arrives');
  test.todo('should keep a multi-byte character split across chunks intact');
  test.todo("should restore a trusted tool's arguments and leave an untrusted tool's alone");
  test.todo('should restore a whole JSON reply with a matching content-length');
  test.todo('should pass every recorded Claude Code reply through byte for byte');
  test.todo('should restore a placeholder from an earlier request in a reply to a clean one');
  test.todo('should leave a placeholder amygdala never issued alone');
  test.todo('should ask the upstream for an uncompressed reply on model requests only');
  test.todo('should answer 502 for a model reply that arrives compressed');
  test.todo('should pass error replies through unchanged');
  test.todo('should cut the client off when the upstream fails mid-stream');
  test.todo('should close the upstream when the client leaves mid-stream');
  test.todo('should leave replies on other paths untouched');
});
