import { describe, test } from 'vitest';

describe('OpensslMinter', () => {
  test.todo('should make a CA and a host certificate for exactly the given hosts');
  test.todo('should cover each host and no other, signed by the CA');
  test.todo("should give a key and certificate Node's TLS loads");
  test.todo('should hand openssl private keys only on stdin and leave no folder behind');
  test.todo('should make a new CA and serial every time');
  test.todo('should name the step when openssl fails');
  test.todo('should refuse certificates that fail the self-check');
  test.todo('should refuse an empty host list before running openssl');
});
