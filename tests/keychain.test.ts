import { describe, test } from 'vitest';

describe('MacKeychain', () => {
  test.todo('should read back a key it stored, on a throwaway keychain');
  test.todo('should report a missing account as none');
  test.todo('should store a key for a folder path with a space');
  test.todo('should pass the key on stdin, never in the arguments, with an empty trusted list');
  test.todo('should check for a key by name without reading it');
  test.todo('should refuse a duplicate, a refused read and other failures without the key');
  test.todo('should refuse a folder path holding a quote, a backslash or a line break');
});
