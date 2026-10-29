import { describe, test } from 'vitest';

describe('run', () => {
  test.todo('should print the version from package.json and exit 0 for --version');
  test.todo('should print usage and exit 0 for --help');
  test.todo('should print usage and exit 0 with no arguments');
  test.todo('should name an unknown command on stderr and exit 2, even a near miss');
});

describe('packageVersion', () => {
  test.todo('should read the version field of package.json');
  test.todo('should throw when package.json has no string version field');
});
