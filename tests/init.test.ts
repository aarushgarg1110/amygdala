import { describe, test } from 'vitest';

describe('init', () => {
  test.todo('should create the folder owner-only, a key and the default config');
  test.todo('should keep everything on a second run');
  test.todo('should create a missing key and keep an edited config');
  test.todo('should give every folder its own key');
  test.todo('should ask whether a key exists, never for the key itself');
  test.todo('should refuse a folder path that is a file before touching the Keychain');
});

describe('dataDir', () => {
  test.todo('should use AMYGDALA_DIR, else ~/.amygdala');
});
