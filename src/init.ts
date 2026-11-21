import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CONFIG_FILE, DEFAULT_CONFIG } from './config.ts';
import { newKeyHex } from './key.ts';
import type { SecretStore } from './keychain.ts';

/** Overrides the data folder; development uses ~/.amygdala-dev, never the real one. */
export const DATA_DIR_ENV = 'AMYGDALA_DIR';
// Owner only: the folder holds the config now and the audit log later.
const FOLDER_MODE = 0o700;

/** `init` can't go on; nothing after the failing step was done. */
export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitError';
  }
}

/** The data folder: AMYGDALA_DIR if set, else ~/.amygdala, as a full path. */
export function dataDir(env: Readonly<Record<string, string | undefined>>, home = homedir()) {
  const chosen = env[DATA_DIR_ENV];
  return chosen === undefined || chosen === '' ? join(home, '.amygdala') : resolve(chosen);
}

/**
 * Sets up the data folder `dir`: the folder, its key in `store` and a default config. Anything
 * that exists is kept, so running it twice changes nothing. Returns one line per item.
 */
export function init(dir: string, store: SecretStore): string[] {
  const lines: string[] = [];
  const folder = statSync(dir, { throwIfNoEntry: false });
  if (folder === undefined) {
    // The umask can only narrow this mode, never widen it.
    mkdirSync(dir, { recursive: true, mode: FOLDER_MODE });
    lines.push(`created ${dir} (owner only)`);
  } else if (folder.isDirectory()) {
    lines.push(`kept    ${dir}`);
  } else {
    throw new InitError(`${dir} exists and is not a folder`);
  }
  // By name only, so a rerun never makes macOS ask for the keychain password.
  if (store.has(dir)) {
    lines.push('kept    the key in the Keychain');
  } else {
    store.add(dir, newKeyHex());
    lines.push(
      'created a key in the Keychain (macOS will ask for your password when amygdala starts)',
    );
  }
  const file = join(dir, CONFIG_FILE);
  if (statSync(file, { throwIfNoEntry: false }) === undefined) {
    writeFileSync(file, DEFAULT_CONFIG, { mode: 0o600, flag: 'wx' });
    lines.push(`created ${file} (add a detector before starting)`);
  } else {
    lines.push(`kept    ${file}`);
  }
  return lines;
}
