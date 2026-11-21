import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import type { CertMinter } from './certs.ts';
import type { SecretStore } from './keychain.ts';

/** The CA protected sessions trust (NODE_EXTRA_CA_CERTS), and the certificate the proxy shows. */
export const CA_FILE = 'ca.pem';
export const HOST_FILE = 'host.pem';
/** Renew this close to expiry, so a running setup never meets an expired certificate. */
export const RENEW_DAYS = 30;
const DAY_MS = 86_400_000;

/** A checked set, ready for the proxy. */
export interface LoadedCertificates {
  readonly caPem: string;
  readonly certPem: string;
  readonly keyPem: string;
  readonly notAfter: Date;
  readonly daysLeft: number;
}

/** The stored certificates can't be used; the message says how to fix it, never holds a key. */
export class CertificateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertificateError';
  }
}

export interface CertDeps {
  /** Holds the host key: KEYCHAIN's `amygdala-tls` service, read without a prompt. */
  readonly tlsKeys: SecretStore;
  readonly minter: CertMinter;
  readonly now?: () => Date;
}

const readText = (file: string) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

// The key is stored as one line of base64 PKCS#8 DER: nothing for `security -i` to escape.
const keyPemOf = (stored: string) =>
  createPrivateKey({ key: Buffer.from(stored, 'base64'), format: 'der', type: 'pkcs8' })
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();

type Stored =
  | { readonly ok: true; readonly set: LoadedCertificates; readonly hosts: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly nothing: boolean };

/** What is stored for `dir`, checked as far as it goes without knowing the configured hosts. */
function stored(dir: string, tlsKeys: SecretStore, now: Date): Stored {
  const caPem = readText(join(dir, CA_FILE));
  const certPem = readText(join(dir, HOST_FILE));
  const key = tlsKeys.read(dir);
  if (caPem === undefined && certPem === undefined && key === undefined) {
    return { ok: false, reason: 'none yet', nothing: true };
  }
  if (caPem === undefined || certPem === undefined) {
    return { ok: false, reason: 'a certificate file is missing', nothing: false };
  }
  if (key === undefined) return { ok: false, reason: 'the host key is missing', nothing: false };
  let cert: X509Certificate;
  let keyPem: string;
  try {
    cert = new X509Certificate(certPem);
    if (!cert.verify(new X509Certificate(caPem).publicKey)) {
      return { ok: false, reason: 'the host certificate is not signed by the CA', nothing: false };
    }
    keyPem = keyPemOf(key);
  } catch {
    return { ok: false, reason: 'a certificate or the key is unreadable', nothing: false };
  }
  try {
    createSecureContext({ key: keyPem, cert: certPem });
  } catch {
    return { ok: false, reason: 'the host key does not match its certificate', nothing: false };
  }
  const notAfter = new Date(cert.validTo);
  const daysLeft = Math.floor((notAfter.getTime() - now.getTime()) / DAY_MS);
  if (daysLeft < 0) return { ok: false, reason: 'they have expired', nothing: false };
  // Only DNS names count; a certificate with none lists no hosts, which reads as a host change.
  const hosts = String(cert.subjectAltName)
    .split(', ')
    .filter((name) => name.startsWith('DNS:'))
    .map((name) => name.slice('DNS:'.length));
  return { ok: true, set: { caPem, certPem, keyPem, notAfter, daysLeft }, hosts };
}

const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Makes sure `dir` holds certificates for exactly `hosts` with more than RENEW_DAYS left: keeps a
 * good set, otherwise mints a new one, then replaces the key and writes the files, so a failed
 * mint leaves the old set as it was. Returns `init`'s line for it.
 */
export function ensureCertificates(dir: string, hosts: readonly string[], deps: CertDeps): string {
  const now = deps.now?.() ?? new Date();
  const current = stored(dir, deps.tlsKeys, now);
  let reason: string | undefined;
  if (!current.ok) {
    reason = current.reason;
  } else {
    const added = hosts.filter((host) => !current.hosts.includes(host));
    const removed = current.hosts.filter((host) => !hosts.includes(host));
    if (added.length > 0 || removed.length > 0) {
      const change = [...added.map((h) => `+${h}`), ...removed.map((h) => `-${h}`)];
      reason = `the hosts changed (${change.join(', ')})`;
    } else if (current.set.daysLeft < RENEW_DAYS) {
      reason = `fewer than ${String(RENEW_DAYS)} days were left`;
    }
  }
  const count = `${String(hosts.length)} hosts`;
  if (reason === undefined && current.ok) {
    return `kept    certificates for ${count}, valid until ${day(current.set.notAfter)}`;
  }
  const fresh = deps.minter.mint(hosts);
  deps.tlsKeys.remove(dir);
  deps.tlsKeys.add(dir, Buffer.from(fresh.keyDer).toString('base64'));
  writeFileSync(join(dir, CA_FILE), fresh.caPem, { mode: 0o600 });
  writeFileSync(join(dir, HOST_FILE), fresh.certPem, { mode: 0o600 });
  const until = `valid until ${day(fresh.notAfter)}`;
  if (!current.ok && current.nothing) return `created certificates for ${count}, ${until}`;
  return `renewed certificates for ${count}, ${until}: ${String(reason)}; restart protected sessions`;
}

/** The certificates for `dir`, checked, for the proxy to present. */
export function loadCertificates(dir: string, tlsKeys: SecretStore, now = new Date()) {
  const current = stored(dir, tlsKeys, now);
  if (!current.ok) {
    throw new CertificateError(
      `no usable certificates for ${dir} (${current.reason}): run \`amygdala init\``,
    );
  }
  return current.set;
}
