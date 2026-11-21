import { describe, test } from 'vitest';

describe('ensureCertificates', () => {
  test.todo('should create a set in a fresh folder');
  test.todo('should keep a good set without minting');
  test.todo('should renew when a host is added or removed');
  test.todo('should renew near or past expiry');
  test.todo('should renew a missing or broken set');
  test.todo('should leave the old set as it was when minting fails');
  test.todo('should never touch the placeholder key');
});

describe('loadCertificates', () => {
  test.todo('should return a good set with its days left');
  test.todo('should refuse a missing, mismatched or expired set');
});

describe('init with certificates', () => {
  test.todo('should read hosts from a config with no detectors');
  test.todo('should stop on a broken proxy section before minting');
});
