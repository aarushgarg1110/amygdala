import { describe, test } from 'vitest';

describe('buildDetectors', () => {
  test.todo('should build one detector per config entry, in order, named <kind>:<name>');
  test.todo('should reject an unknown detector kind');
  test.todo('should reject a repeated detector name');
  test.todo('should reject a repeated prefix');
  test.todo('should reject a name that is not lowercase letters, digits and hyphens');
  test.todo('should reject a bad prefix with the shared prefix message');
});
