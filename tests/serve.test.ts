import { describe, test } from 'vitest';

describe('serve', () => {
  test.todo('should scrub a model request on the configured port');
  test.todo('should refuse to start when the key, config or certificates are missing');
  test.todo('should refuse a taken port without reading the key');
  test.todo('should refuse a second serve for the same data folder without reading the key');
  test.todo('should report its state through status while running');
  test.todo('should report not running, and remove a stale socket');
  test.todo('should keep the control socket private to the owner');
  test.todo('should stop listening and remove the socket on SIGTERM and SIGINT');
  test.todo('should log one line per request with no value or key in it');
  test.todo('should read the key exactly once');
});
