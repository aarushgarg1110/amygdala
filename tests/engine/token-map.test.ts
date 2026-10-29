import { describe, test } from 'vitest';

describe('TokenMap', () => {
  test.todo('should return the original value for an issued placeholder');
  test.todo('should keep the first spelling when the same canonical value is issued again');
  test.todo('should return undefined for a placeholder it never issued');
  test.todo('should throw PlaceholderCollisionError when two values get one placeholder');
  test.todo('should never show values when inspected, serialized or converted to a string');
  test.todo('should restore any issued value (property)');
  test.todo('should issue the same placeholder for the same value (property)');
});
