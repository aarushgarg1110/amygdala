import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { packageVersion, run } from '../src/run.ts';

const MANIFEST_VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
  .version;

describe('run', () => {
  test('should print the version from package.json and exit 0 for --version', () => {
    // Assemble
    const args = ['--version'];

    // Act
    const outcome = run(args);

    // Assert
    expect(outcome).toEqual({ exitCode: 0, stdout: `${MANIFEST_VERSION}\n`, stderr: '' });
  });

  test('should print usage and exit 0 for --help', () => {
    // Act
    const outcome = run(['--help']);

    // Assert
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toMatch(/^Usage: amygdala <command>/);
    expect(outcome.stderr).toBe('');
  });

  test('should print usage and exit 0 with no arguments', () => {
    // Act
    const outcome = run([]);

    // Assert: the same as --help
    expect(outcome).toEqual(run(['--help']));
  });

  test.each(['bogus', '--versio', 'version', '--Version'])(
    'should name an unknown command on stderr and exit 2, even a near miss: %s',
    (command) => {
      // Act
      const outcome = run([command]);

      // Assert
      expect(outcome).toEqual({
        exitCode: 2,
        stdout: '',
        stderr: `amygdala: unknown command "${command}". Run amygdala --help.\n`,
      });
    },
  );
});

describe('packageVersion', () => {
  test('should read the version field of package.json', () => {
    // Act
    const version = packageVersion();

    // Assert
    expect(version).toBe(MANIFEST_VERSION);
  });

  test.each(['{}', '{"version": 1}', 'null', '[]', '"0.0.0"'])(
    'should throw when package.json has no string version field: %s',
    (manifest) => {
      // Assemble
      const read = () => manifest;

      // Act and Assert
      expect(() => packageVersion(read)).toThrow('package.json has no string "version" field');
    },
  );
});
