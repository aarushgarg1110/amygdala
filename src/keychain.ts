import { spawnSync } from 'node:child_process';

/** Where amygdala's key lives. The real one is the macOS Keychain; tests use an in-memory one. */
export interface SecretStore {
  /** Whether a secret is stored for `account`, found by name: reading it isn't needed. */
  has(account: string): boolean;
  /** The secret stored for `account`, or undefined when there is none. */
  read(account: string): string | undefined;
  /** Stores `secret` for `account`. Throws if one is already there: it never overwrites. */
  add(account: string, secret: string): void;
}

/** The Keychain's service name for amygdala's keys; the account is the data folder's path. */
export const KEYCHAIN_SERVICE = 'amygdala';
const SECURITY = '/usr/bin/security';
// security's exit statuses, measured on 11-20: no such item; it already exists; a dialog was denied.
const ITEM_NOT_FOUND = 44;
const DUPLICATE_ITEM = 45;
const USER_CANCELED = 128;
// security -i splits its input like a shell, so a value holding one of these would need escaping.
const UNQUOTABLE = /["\\\n\r]/;

/** The Keychain refused or failed; the message never holds the key. */
export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainError';
  }
}

/** Runs `command` with `args`, writing `input` to its stdin. Swappable so tests can record calls. */
export type Run = (
  command: string,
  args: readonly string[],
  input?: string,
) => { readonly status: number | null; readonly stdout: string; readonly stderr: string };

const runSecurity: Run = (command, args, input) => {
  const result = spawnSync(command, args, { input, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

export interface MacKeychainOptions {
  /** A keychain file instead of the user's default keychain (tests use a throwaway one). */
  readonly keychain?: string;
  /**
   * Whether macOS asks for the keychain password before every read (an empty trusted-app list).
   * On by default (Q15): an unexpected read, by an agent's shell say, shows a dialog to deny.
   */
  readonly askOnRead?: boolean;
  readonly run?: Run;
}

/** The macOS Keychain through `/usr/bin/security`. */
export class MacKeychain implements SecretStore {
  readonly #file: readonly string[];
  readonly #askOnRead: boolean;
  readonly #run: Run;

  constructor(options: MacKeychainOptions = {}) {
    this.#file = options.keychain === undefined ? [] : [options.keychain];
    this.#askOnRead = options.askOnRead ?? true;
    this.#run = options.run ?? runSecurity;
  }

  has(account: string): boolean {
    // Without -w only the item's name is looked up, which needs no decryption and so no dialog.
    const result = this.#run(SECURITY, ['find-generic-password', ...this.#item(account, [])]);
    if (result.status === ITEM_NOT_FOUND) return false;
    if (result.status !== 0) throw this.#failure('look up', result.status);
    return true;
  }

  read(account: string): string | undefined {
    const result = this.#run(SECURITY, ['find-generic-password', ...this.#item(account, ['-w'])]);
    if (result.status === ITEM_NOT_FOUND) return undefined;
    if (result.status === USER_CANCELED) {
      throw new KeychainError('the Keychain dialog was denied, so amygdala has no key');
    }
    if (result.status !== 0) throw this.#failure('read', result.status);
    return result.stdout.replace(/\n$/, '');
  }

  add(account: string, secret: string): void {
    for (const value of [account, ...this.#file]) {
      if (UNQUOTABLE.test(value)) {
        throw new KeychainError(`"${value}" holds a quote, backslash or line break`);
      }
    }
    // The command goes in on stdin (security -i), so the key never appears in a process list.
    const words = [
      'add-generic-password',
      ...this.#item(account, ['-w', secret, ...(this.#askOnRead ? ['-T', ''] : [])]),
    ];
    const line = words.map((word) => `"${word}"`).join(' ');
    const result = this.#run(SECURITY, ['-i'], `${line}\n`);
    if (result.status === DUPLICATE_ITEM) {
      throw new KeychainError(`a key for ${account} is already in the Keychain`);
    }
    if (result.status !== 0) throw this.#failure('store', result.status);
  }

  // security stops reading options at the first plain argument, so the keychain file goes last.
  #item(account: string, options: readonly string[]): string[] {
    return ['-s', KEYCHAIN_SERVICE, '-a', account, ...options, ...this.#file];
  }

  // The status only: the tool's own message could, in some failure, echo what it was given.
  #failure(action: string, status: number | null): KeychainError {
    return new KeychainError(
      `the Keychain could not ${action} the key (security exit ${String(status)})`,
    );
  }
}
