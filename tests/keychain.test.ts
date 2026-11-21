import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  KEYCHAIN_SERVICE,
  KeychainError,
  MacKeychain,
  TLS_KEY_SERVICE,
  tlsKeyStore,
} from '../src/keychain.ts';
import type { Run } from '../src/process.ts';

const SECRET = 'ab'.repeat(32);

/** A stand-in for /usr/bin/security that records each call and answers with `status`. */
function recorder(status: number | null, stdout = '') {
  const calls: { args: readonly string[]; input: string | undefined }[] = [];
  const run: Run = (command, args, input) => {
    expect(command).toBe('/usr/bin/security');
    calls.push({ args, input });
    return { status, stdout, stderr: `security: something about ${SECRET}` };
  };
  return { calls, run };
}

describe('MacKeychain', () => {
  test('should pass the key on stdin, never in the arguments, with an empty trusted list', () => {
    // Act
    const { calls, run } = recorder(0);
    new MacKeychain({ run }).add('/data/amygdala', SECRET);
    const plain = recorder(0);
    new MacKeychain({ run: plain.run, askOnRead: false }).add('/data/amygdala', SECRET);
    const filed = recorder(0);
    new MacKeychain({ run: filed.run, keychain: '/k/test.keychain-db' }).add('/d', SECRET);

    // Assert: options before the keychain file, which security reads as the end of its options
    expect(calls).toEqual([
      {
        args: ['-i'],
        input: `"add-generic-password" "-s" "${KEYCHAIN_SERVICE}" "-a" "/data/amygdala" "-w" "${SECRET}" "-T" ""\n`,
      },
    ]);
    expect(plain.calls[0]?.input).not.toContain('"-T"');
    expect(filed.calls[0]?.input).toMatch(/"-T" "" "\/k\/test\.keychain-db"\n$/);
  });

  test('should check for a key by name without reading it', () => {
    // Act
    const { calls, run } = recorder(0, `${SECRET}\n`);
    const keychain = new MacKeychain({ run, keychain: '/k/test.keychain-db' });
    const found = keychain.has('/data/amygdala');
    const read = keychain.read('/data/amygdala');

    // Assert: only read asks for the secret (-w), which is what makes macOS ask for the password
    expect(found).toBe(true);
    expect(read).toBe(SECRET);
    expect(calls.map((call) => call.args)).toEqual([
      ['find-generic-password', '-s', 'amygdala', '-a', '/data/amygdala', '/k/test.keychain-db'],
      [
        'find-generic-password',
        '-s',
        'amygdala',
        '-a',
        '/data/amygdala',
        '-w',
        '/k/test.keychain-db',
      ],
    ]);
  });

  test('should report a missing account as none', () => {
    const keychain = new MacKeychain({ run: recorder(44).run });
    expect([keychain.has('/nowhere'), keychain.read('/nowhere')]).toEqual([false, undefined]);
  });

  test.each([
    [
      'a duplicate add',
      45,
      (k: MacKeychain) => {
        k.add('/d', SECRET);
      },
      'a key for /d is already in the Keychain',
    ],
    [
      'a denied dialog',
      128,
      (k: MacKeychain) => k.read('/d'),
      'the Keychain dialog was denied, so amygdala has no key',
    ],
    [
      'a failed read',
      51,
      (k: MacKeychain) => k.read('/d'),
      'the Keychain could not read the key (security exit 51)',
    ],
    [
      'a failed lookup',
      51,
      (k: MacKeychain) => k.has('/d'),
      'the Keychain could not look up the key (security exit 51)',
    ],
    [
      'a failed add',
      1,
      (k: MacKeychain) => {
        k.add('/d', SECRET);
      },
      'the Keychain could not store the key (security exit 1)',
    ],
    [
      'a killed process',
      null,
      (k: MacKeychain) => k.read('/d'),
      'the Keychain could not read the key (security exit null)',
    ],
  ])(
    'should refuse a duplicate, a refused read and other failures without the key: %s',
    (label, status, act, message) => {
      const keychain = new MacKeychain({ run: recorder(status).run });
      let error: unknown;
      try {
        act(keychain);
      } catch (caught) {
        error = caught;
      }
      expect(error).toEqual(new KeychainError(message));
      expect((error as Error).message).not.toContain(SECRET);
    },
  );

  test('should use the host-key service without a prompt, and remove items', () => {
    // Act
    const { calls, run } = recorder(0);
    const tls = tlsKeyStore(run);
    tls.add('/data/amygdala', SECRET);
    tls.remove('/data/amygdala');

    // Assert: its own service, no empty trusted list, and delete by name
    expect(calls[0]?.input).toBe(
      `"add-generic-password" "-s" "amygdala-tls" "-a" "/data/amygdala" "-w" "${SECRET}"\n`,
    );
    expect(calls[1]?.args).toEqual([
      'delete-generic-password',
      '-s',
      'amygdala-tls',
      '-a',
      '/data/amygdala',
    ]);
  });

  test.each([
    [44, undefined],
    [1, 'the Keychain could not remove the key (security exit 1)'],
  ])(
    'should treat removing a missing item as done, and other failures as errors: exit %i',
    (status, message) => {
      const remove = () => {
        new MacKeychain({ run: recorder(status).run }).remove('/d');
      };
      if (message === undefined) expect(remove).not.toThrow();
      else expect(remove).toThrow(new KeychainError(message));
    },
  );

  test.each(['/a "quoted" dir', '/a\\back', '/a\nline'])(
    'should refuse a folder path holding a quote, a backslash or a line break: %j',
    (account) => {
      const { calls, run } = recorder(0);
      expect(() => {
        new MacKeychain({ run }).add(account, SECRET);
      }).toThrow(KeychainError);
      expect(calls).toEqual([]);
    },
  );

  // The real /usr/bin/security, on a throwaway keychain file. Its items trust security itself
  // (askOnRead: false), because a test can't answer the password dialog.
  describe.runIf(process.platform === 'darwin')('on a throwaway keychain', () => {
    let folder = '';
    let keychain = '';
    const security = (...args: string[]) => execFileSync('/usr/bin/security', args);
    beforeAll(() => {
      folder = mkdtempSync(join(tmpdir(), 'amygdala-keychain-'));
      keychain = join(folder, 'test.keychain-db');
      security('create-keychain', '-p', 'test', keychain);
      security('unlock-keychain', '-p', 'test', keychain);
    });
    afterAll(() => {
      security('delete-keychain', keychain);
      rmSync(folder, { recursive: true, force: true });
    });

    test('should read back a key it stored, on a throwaway keychain', () => {
      const store = new MacKeychain({ keychain, askOnRead: false });
      store.add('/data/one', SECRET);
      expect([store.has('/data/one'), store.read('/data/one')]).toEqual([true, SECRET]);
      expect(() => {
        store.add('/data/one', SECRET);
      }).toThrow('already in the Keychain');
      expect([store.has('/data/none'), store.read('/data/none')]).toEqual([false, undefined]);
    });

    test('should store a key for a folder path with a space', () => {
      const store = new MacKeychain({ keychain, askOnRead: false });
      store.add('/Users/a b/.amygdala', SECRET);
      expect(store.read('/Users/a b/.amygdala')).toBe(SECRET);
    });

    test('should keep the host-key service apart and remove its items', () => {
      // Assemble: a main key and a host key for one folder
      const main = new MacKeychain({ keychain, askOnRead: false });
      const tls = new MacKeychain({ keychain, service: TLS_KEY_SERVICE, askOnRead: false });
      main.add('/data/two', SECRET);
      tls.add('/data/two', 'host-key');

      // Act
      tls.remove('/data/two');
      tls.remove('/data/two');

      // Assert: only the host key went, and a second remove is fine
      expect([tls.has('/data/two'), main.read('/data/two')]).toEqual([false, SECRET]);
    });
  });
});
