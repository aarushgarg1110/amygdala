import { describe, test } from 'vitest';

describe('start and stop', () => {
  test.todo('should install and load an agent that runs serve, then report it started');
  test.todo('should give each data folder its own agent');
  test.todo('should refuse a broken setup without installing anything or reading the key');
  test.todo('should undo the install when the proxy never answers');
  test.todo('should boot out a loaded agent of the same label before loading');
  test.todo('should report a failed bootstrap and remove the plist');
  test.todo('should stop and uninstall, and say when nothing is installed');
  test.todo('should exit 0 on a refused start under launchd, non-zero on a crash');
});
