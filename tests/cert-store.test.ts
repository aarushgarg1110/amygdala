import { generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CA_FILE,
  CertificateError,
  ensureCertificates,
  HOST_FILE,
  loadCertificates,
  RENEW_DAYS,
} from '../src/cert-store.ts';
import { MintError, type CertMinter } from '../src/certs.ts';
import { CONFIG_FILE, ConfigError, DEFAULT_INTERCEPT_HOSTS as HOSTS } from '../src/config.ts';
import { init } from '../src/init.ts';
import { depsFor, MINTER } from './deps.ts';
import { MemoryStore } from './memory-store.ts';

const DAY_MS = 86_400_000;
const FOLDERS: string[] = [];
afterEach(() => {
  for (const dir of FOLDERS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real minter that counts its calls, or one that always fails. */
function minter(fail = false): CertMinter & { calls: number } {
  const counted = {
    calls: 0,
    mint(hosts: readonly string[]) {
      counted.calls += 1;
      if (fail) throw new MintError('openssl could not make the CA certificate (exit 1)');
      return MINTER.mint(hosts);
    },
  };
  return counted;
}

/** A fresh data folder, an empty host-key store and a counting minter. */
function setUp() {
  const dir = mkdtempSync(join(tmpdir(), 'amygdala-certs-'));
  FOLDERS.push(dir);
  return { dir, tlsKeys: new MemoryStore(), minter: minter() };
}

/** Both certificate files and the stored key, to compare before and after. */
const snapshot = (dir: string, tlsKeys: MemoryStore) => [
  readFileSync(join(dir, CA_FILE), 'utf8'),
  readFileSync(join(dir, HOST_FILE), 'utf8'),
  tlsKeys.secrets.get(dir),
];

const otherKey = () =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'der' })
    .toString('base64');

describe('ensureCertificates', () => {
  test('should create a set in a fresh folder', () => {
    // Act
    const { dir, tlsKeys, minter: counted } = setUp();
    const line = ensureCertificates(dir, HOSTS, { tlsKeys, minter: counted });

    // Assert
    expect(line).toMatch(/^created certificates for 4 hosts, valid until \d{4}-\d\d-\d\d$/);
    expect(counted.calls).toBe(1);
    expect(statSync(join(dir, CA_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, HOST_FILE)).mode & 0o777).toBe(0o600);
    expect(tlsKeys.secrets.get(dir)).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(loadCertificates(dir, tlsKeys).daysLeft).toBeGreaterThan(390);
  });

  test('should keep a good set without minting', () => {
    // Assemble
    const { dir, tlsKeys, minter: counted } = setUp();
    ensureCertificates(dir, HOSTS, { tlsKeys, minter: counted });
    const before = snapshot(dir, tlsKeys);

    // Act
    const line = ensureCertificates(dir, [...HOSTS].reverse(), { tlsKeys, minter: counted });

    // Assert: the same hosts in another order are the same set
    expect(line).toMatch(/^kept {4}certificates for 4 hosts, valid until /);
    expect(counted.calls).toBe(1);
    expect(snapshot(dir, tlsKeys)).toEqual(before);
  });

  test.each([
    ['a host added', [...HOSTS, 'example.org'], '(+example.org)', 5],
    ['a host removed', HOSTS.slice(0, 3), '(-http-intake.logs.us5.datadoghq.com)', 3],
  ])('should renew when a host is added or removed: %s', (label, hosts, change, count) => {
    // Assemble
    const { dir, tlsKeys, minter: counted } = setUp();
    ensureCertificates(dir, HOSTS, { tlsKeys, minter: counted });
    const before = snapshot(dir, tlsKeys);

    // Act
    const line = ensureCertificates(dir, hosts, { tlsKeys, minter: counted });

    // Assert
    expect(line).toContain(`renewed certificates for ${String(count)} hosts`);
    expect(line).toContain(`the hosts changed ${change}; restart protected sessions`);
    expect(snapshot(dir, tlsKeys).every((part, i) => part !== before[i])).toBe(true);
    expect(loadCertificates(dir, tlsKeys).certPem).toBe(snapshot(dir, tlsKeys)[1]);
  });

  test.each([
    ['31 days left', RENEW_DAYS + 1, 'kept'],
    ['30 days and an hour left', RENEW_DAYS + 1 / 24, 'kept'],
    ['29 days left', RENEW_DAYS - 1, `fewer than ${String(RENEW_DAYS)} days were left`],
    ['a day past', -1, 'they have expired'],
  ])('should renew near or past expiry: %s', (label, daysLeft, outcome) => {
    // Assemble
    const { dir, tlsKeys, minter: counted } = setUp();
    ensureCertificates(dir, HOSTS, { tlsKeys, minter: counted });
    const { notAfter } = loadCertificates(dir, tlsKeys);
    const now = () => new Date(notAfter.getTime() - daysLeft * DAY_MS);

    // Act
    const line = ensureCertificates(dir, HOSTS, { tlsKeys, minter: counted, now });

    // Assert
    expect(line).toContain(outcome);
    expect(counted.calls).toBe(outcome === 'kept' ? 1 : 2);
  });

  test.each([
    [
      'the host certificate deleted',
      (dir: string) => {
        unlinkSync(join(dir, HOST_FILE));
      },
      'a certificate file is missing',
    ],
    [
      'the host key deleted',
      (dir: string, keys: MemoryStore) => {
        keys.remove(dir);
      },
      'the host key is missing',
    ],
    [
      'another key stored',
      (dir: string, keys: MemoryStore) => keys.secrets.set(dir, otherKey()),
      'the host key does not match its certificate',
    ],
    [
      'an unreadable certificate',
      (dir: string) => {
        writeFileSync(join(dir, HOST_FILE), 'garbage');
      },
      'a certificate or the key is unreadable',
    ],
    [
      'a CA that did not sign it',
      (dir: string) => {
        writeFileSync(join(dir, CA_FILE), MINTER.mint(HOSTS).caPem);
      },
      'the host certificate is not signed by the CA',
    ],
  ])('should renew a missing or broken set: %s', (label, breakIt, reason) => {
    // Assemble
    const { dir, tlsKeys, minter: counted } = setUp();
    ensureCertificates(dir, HOSTS, { tlsKeys, minter: counted });
    breakIt(dir, tlsKeys);

    // Act
    const line = ensureCertificates(dir, HOSTS, { tlsKeys, minter: counted });

    // Assert: renewed, and the new set loads
    expect(line).toContain(`: ${reason}; restart protected sessions`);
    expect(() => loadCertificates(dir, tlsKeys)).not.toThrow();
  });

  test('should leave the old set as it was when minting fails', () => {
    // Assemble
    const { dir, tlsKeys, minter: counted } = setUp();
    ensureCertificates(dir, HOSTS, { tlsKeys, minter: counted });
    const before = snapshot(dir, tlsKeys);

    // Act and Assert
    expect(() =>
      ensureCertificates(dir, [...HOSTS, 'example.org'], { tlsKeys, minter: minter(true) }),
    ).toThrow(MintError);
    expect(snapshot(dir, tlsKeys)).toEqual(before);
  });

  test('should never touch the placeholder key', () => {
    // Assemble: init, then a host change in the config, so the second init renews
    const { dir } = setUp();
    const store = new MemoryStore();
    const deps = depsFor(store);
    init(dir, deps);
    const key = store.secrets.get(dir);
    writeFileSync(join(dir, CONFIG_FILE), '[proxy]\nintercept_hosts = ["api.anthropic.com"]\n');

    // Act
    const lines = init(dir, deps);

    // Assert
    expect(lines[3]).toContain('renewed certificates for 1 hosts');
    expect(store.secrets.get(dir)).toBe(key);
    expect(store.calls).toEqual([`has ${dir}`, `add ${dir}`, `has ${dir}`]);
  });
});

describe('loadCertificates', () => {
  test('should return a good set with its days left', () => {
    // Assemble
    const { dir, tlsKeys, minter: counted } = setUp();
    ensureCertificates(dir, HOSTS, { tlsKeys, minter: counted });

    // Act
    const set = loadCertificates(dir, tlsKeys);

    // Assert
    expect(set.caPem).toBe(readFileSync(join(dir, CA_FILE), 'utf8'));
    expect(set.certPem).toBe(readFileSync(join(dir, HOST_FILE), 'utf8'));
    expect(() => createSecureContext({ key: set.keyPem, cert: set.certPem })).not.toThrow();
    expect(set.daysLeft).toBe(Math.floor((set.notAfter.getTime() - Date.now()) / DAY_MS));
  });

  test.each([
    [
      'no files',
      (dir: string) => {
        unlinkSync(join(dir, CA_FILE));
      },
      'a certificate file is missing',
    ],
    [
      'no key',
      (dir: string, keys: MemoryStore) => {
        keys.remove(dir);
      },
      'the host key is missing',
    ],
    [
      'another key',
      (dir: string, keys: MemoryStore) => keys.secrets.set(dir, otherKey()),
      'the host key does not match its certificate',
    ],
  ])('should refuse a missing, mismatched or expired set: %s', (label, breakIt, reason) => {
    // Assemble
    const { dir, tlsKeys, minter: counted } = setUp();
    ensureCertificates(dir, HOSTS, { tlsKeys, minter: counted });
    breakIt(dir, tlsKeys);

    // Act and Assert
    expect(() => loadCertificates(dir, tlsKeys)).toThrow(
      new CertificateError(`no usable certificates for ${dir} (${reason}): run \`amygdala init\``),
    );
  });

  test('should refuse an expired set', () => {
    const { dir, tlsKeys, minter: counted } = setUp();
    ensureCertificates(dir, HOSTS, { tlsKeys, minter: counted });
    const later = new Date(Date.now() + 400 * DAY_MS);
    expect(() => loadCertificates(dir, tlsKeys, later)).toThrow('(they have expired)');
  });

  test('should refuse a folder with nothing in it', () => {
    const { dir, tlsKeys } = setUp();
    expect(() => loadCertificates(dir, tlsKeys)).toThrow('(none yet)');
  });
});

describe('init with certificates', () => {
  test('should read hosts from a config with no detectors', () => {
    // Assemble: a fresh init, then hosts edited, still with no detector
    const { dir } = setUp();
    const deps = depsFor(new MemoryStore());
    const first = init(dir, deps);
    writeFileSync(
      join(dir, CONFIG_FILE),
      '[proxy]\nintercept_hosts = ["api.anthropic.com", "example.org"]\n',
    );

    // Act
    const second = init(dir, deps);

    // Assert
    expect(first[3]).toMatch(/^created certificates for 4 hosts/);
    expect(second[3]).toContain('the hosts changed (+example.org, -mcp-proxy.anthropic.com');
  });

  test('should stop on a broken proxy section before minting', () => {
    // Assemble
    const { dir } = setUp();
    writeFileSync(
      join(dir, CONFIG_FILE),
      '[proxy]\nintercept_hosts = ["https://api.anthropic.com"]\n',
    );
    const counted = minter();

    // Act and Assert
    expect(() => init(dir, depsFor(new MemoryStore(), { minter: counted }))).toThrow(ConfigError);
    expect(counted.calls).toBe(0);
    expect(existsSync(join(dir, HOST_FILE))).toBe(false);
  });
});
