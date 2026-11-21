import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { KeychainError } from '../src/keychain.ts';
import { packageVersion, run } from '../src/run.ts';
import { MemoryStore } from './memory-store.ts';

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

describe('run init', () => {
  const dirs: string[] = [];
  const parent = () => {
    const dir = mkdtempSync(join(tmpdir(), 'amygdala-run-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('should run init in AMYGDALA_DIR and list it in --help', () => {
    // Act
    const dir = join(parent(), 'data');
    const store = new MemoryStore();
    const outcome = run(['init'], { env: { AMYGDALA_DIR: dir }, store });

    // Assert
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.split('\n')[0]).toBe(`created ${dir} (owner only)`);
    expect(store.secrets.has(dir)).toBe(true);
    expect(run(['--help']).stdout).toMatch(/^ {2}init {7}Create the data folder/m);
  });

  test('should exit 2 for an unknown init option', () => {
    const store = new MemoryStore();
    expect(run(['init', '--force'], { env: {}, store })).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: 'amygdala init: unknown option "--force". Run amygdala --help.\n',
    });
    expect(store.calls).toEqual([]);
  });

  test.each([
    [
      'a folder path that is a file',
      () => {
        const file = join(parent(), 'data');
        writeFileSync(file, '');
        return {
          dir: file,
          store: new MemoryStore(),
          reason: `${file} exists and is not a folder`,
        };
      },
    ],
    [
      'a folder it may not create',
      () => {
        const locked = parent();
        chmodSync(locked, 0o500);
        return { dir: join(locked, 'data'), store: new MemoryStore(), reason: 'EACCES' };
      },
    ],
    [
      'a Keychain refusal',
      () => {
        const store = new MemoryStore();
        store.add = () => {
          throw new KeychainError('the Keychain could not store the key (security exit 1)');
        };
        return { dir: join(parent(), 'data'), store, reason: 'security exit 1' };
      },
    ],
  ])('should exit 1 with the reason when init is refused: %s', (label, setUp) => {
    // Act
    const { dir, store, reason } = setUp();
    const outcome = run(['init'], { env: { AMYGDALA_DIR: dir }, store });

    // Assert
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toMatch(/^amygdala init: /);
    expect(outcome.stderr).toContain(reason);
  });

  test('should let an unexpected error through rather than report it as a refusal', () => {
    const store = new MemoryStore();
    store.has = () => {
      throw new Error('a bug');
    };
    expect(() => run(['init'], { env: { AMYGDALA_DIR: join(parent(), 'd') }, store })).toThrow(
      'a bug',
    );
  });
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
