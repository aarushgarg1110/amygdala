import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CONFIG_FILE, DEFAULT_CONFIG } from '../src/config.ts';
import { dataDir, init, InitError } from '../src/init.ts';
import { MemoryStore } from './memory-store.ts';

const CREATED_DIRS: string[] = [];
/** A fresh path for a data folder that doesn't exist yet. */
function freshDir(): string {
  const parent = mkdtempSync(join(tmpdir(), 'amygdala-init-'));
  CREATED_DIRS.push(parent);
  return join(parent, 'data');
}
afterEach(() => {
  for (const dir of CREATED_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const mode = (path: string) => statSync(path).mode & 0o777;

describe('init', () => {
  test('should create the folder owner-only, a key and the default config', () => {
    // Assemble
    const dir = freshDir();
    const store = new MemoryStore();

    // Act
    const lines = init(dir, store);

    // Assert
    expect(lines).toEqual([
      `created ${dir} (owner only)`,
      'created a key in the Keychain (macOS will ask for your password when amygdala starts)',
      `created ${join(dir, CONFIG_FILE)} (add a detector before starting)`,
    ]);
    expect(mode(dir)).toBe(0o700);
    expect(store.secrets.get(dir)).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, CONFIG_FILE), 'utf8')).toBe(DEFAULT_CONFIG);
    expect(mode(join(dir, CONFIG_FILE))).toBe(0o600);
  });

  test('should keep everything on a second run', () => {
    // Assemble: a first run, then an edit to the config
    const dir = freshDir();
    const store = new MemoryStore();
    init(dir, store);
    const key = store.secrets.get(dir);
    writeFileSync(join(dir, CONFIG_FILE), '# edited\n');

    // Act
    const lines = init(dir, store);

    // Assert
    expect(lines).toEqual([
      `kept    ${dir}`,
      'kept    the key in the Keychain',
      `kept    ${join(dir, CONFIG_FILE)}`,
    ]);
    expect(store.secrets.get(dir)).toBe(key);
    expect(readFileSync(join(dir, CONFIG_FILE), 'utf8')).toBe('# edited\n');
  });

  test('should create a missing key and keep an edited config', () => {
    // Assemble
    const dir = freshDir();
    mkdirSync(dir);
    writeFileSync(join(dir, CONFIG_FILE), '# mine\n');
    const store = new MemoryStore();

    // Act
    const lines = init(dir, store);

    // Assert
    expect(lines[1]).toMatch(/^created a key/);
    expect(lines[2]).toBe(`kept    ${join(dir, CONFIG_FILE)}`);
    expect(store.secrets.has(dir)).toBe(true);
    expect(readFileSync(join(dir, CONFIG_FILE), 'utf8')).toBe('# mine\n');
  });

  test('should give every folder its own key', () => {
    // Act
    const store = new MemoryStore();
    const [one, two] = [freshDir(), freshDir()];
    init(one, store);
    init(two, store);

    // Assert
    expect(store.secrets.size).toBe(2);
    expect(store.secrets.get(one)).not.toBe(store.secrets.get(two));
  });

  test('should ask whether a key exists, never for the key itself', () => {
    // Act
    const dir = freshDir();
    const store = new MemoryStore();
    init(dir, store);
    init(dir, store);

    // Assert: reading would make macOS ask for the password on every rerun
    expect(store.calls).toEqual([`has ${dir}`, `add ${dir}`, `has ${dir}`]);
  });

  test('should refuse a folder path that is a file before touching the Keychain', () => {
    // Assemble
    const dir = freshDir();
    mkdirSync(join(dir, '..'), { recursive: true });
    writeFileSync(dir, 'not a folder');
    const store = new MemoryStore();

    // Act and Assert
    expect(() => init(dir, store)).toThrow(new InitError(`${dir} exists and is not a folder`));
    expect(store.calls).toEqual([]);
  });
});

describe('dataDir', () => {
  test.each([
    ['set', { AMYGDALA_DIR: '/x/.amygdala-dev' }, '/x/.amygdala-dev'],
    ['set to a relative path', { AMYGDALA_DIR: 'rel/dir' }, resolve('rel/dir')],
    ['empty', { AMYGDALA_DIR: '' }, '/home/u/.amygdala'],
    ['unset', {}, '/home/u/.amygdala'],
  ])('should use AMYGDALA_DIR, else ~/.amygdala: %s', (label, env, want) => {
    expect(dataDir(env, '/home/u')).toBe(want);
  });
});
