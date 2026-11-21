import { generateKeyPairSync, randomBytes, X509Certificate, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { runProcess, type Run } from './process.ts';

/** How long both certificates last; rerunning `init` renews them before they run out. */
export const CERT_DAYS = 397;
const OPENSSL = '/usr/bin/openssl';
// R1's curve. Keys come from Node's crypto, so the system's LibreSSL only builds and signs.
const CURVE = 'P-256';
// LibreSSL signs with SHA-1 unless told otherwise, and Node rejects SHA-1 (R1).
const DIGEST = '-sha256';
const SHA256 = /SHA256/i;
const SERIAL_BYTES = 16;
const PEM_BLOCK = /^-----BEGIN [A-Z ]+-----\n[\s\S]+\n-----END [A-Z ]+-----\n?$/;

/** What `init` keeps: the CA certificate sessions trust, and the certificate the proxy presents. */
export interface Certificates {
  readonly caPem: string;
  readonly certPem: string;
  /** The host certificate's private key, PKCS#8 DER. The CA's private key is never returned. */
  readonly keyDer: Uint8Array;
  readonly notAfter: Date;
}

/** Makes certificates: openssl now, a library when other systems arrive (decision 19). */
export interface CertMinter {
  mint(hosts: readonly string[]): Certificates;
}

/** Certificates couldn't be made or failed their check; the message never holds key material. */
export class MintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MintError';
  }
}

const pem = (key: KeyObject) => key.export({ type: 'pkcs8', format: 'pem' }).toString();

/** The host certificate's extensions: every host by name, for TLS servers only. */
function hostExtensions(hosts: readonly string[]): string {
  return [
    `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(',')}`,
    'extendedKeyUsage=serverAuth',
    'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature',
    '',
  ].join('\n');
}

/** Throws unless the new certificates are what was asked for and Node's TLS can use them. */
function selfCheck(caPem: string, certPem: string, keyPem: string, hosts: readonly string[]) {
  let ca: X509Certificate;
  let cert: X509Certificate;
  try {
    ca = new X509Certificate(caPem);
    cert = new X509Certificate(certPem);
  } catch {
    throw new MintError('the new certificates could not be read');
  }
  const problems: string[] = [];
  if (!ca.ca) problems.push('the CA certificate is not a CA');
  if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey)) {
    problems.push('the host certificate is not signed by the CA');
  }
  const names = cert.subjectAltName?.split(', ').map((name) => name.replace(/^DNS:/, '')) ?? [];
  const missing = hosts.filter((host) => cert.checkHost(host) !== host);
  const extra = names.filter((name) => !hosts.includes(name));
  if (missing.length > 0) problems.push(`it doesn't cover ${missing.join(', ')}`);
  if (extra.length > 0) problems.push(`it also covers ${extra.join(', ')}`);
  for (const [label, certificate] of [
    ['CA', ca],
    ['host', cert],
  ] as const) {
    // An algorithm Node can't name reads as "undefined" and fails too.
    if (!SHA256.test(String(certificate.signatureAlgorithm))) {
      problems.push(
        `the ${label} certificate is signed with ${String(certificate.signatureAlgorithm)}`,
      );
    }
  }
  try {
    createSecureContext({ key: keyPem, cert: certPem });
  } catch (error) {
    problems.push(`Node's TLS can't use them (${(error as Error).message})`);
  }
  if (problems.length > 0) {
    throw new MintError(`the new certificates failed their check: ${problems.join('; ')}`);
  }
}

/**
 * Makes a CA and one host certificate with the system's openssl. Both private keys reach openssl
 * only on stdin, so neither is ever written to a file, and the CA's is dropped when this returns:
 * nothing on the machine can make another certificate afterwards.
 */
export class OpensslMinter implements CertMinter {
  readonly #run: Run;

  constructor(options: { readonly run?: Run } = {}) {
    this.#run = options.run ?? runProcess;
  }

  mint(hosts: readonly string[]): Certificates {
    if (hosts.length === 0) throw new MintError('no hosts to make a certificate for');
    // mkdtemp makes the folder owner-only. It holds only public files: certificates, the request.
    const dir = mkdtempSync(join(tmpdir(), 'amygdala-mint-'));
    try {
      const ca = generateKeyPairSync('ec', { namedCurve: CURVE });
      const host = generateKeyPairSync('ec', { namedCurve: CURVE });
      const days = String(CERT_DAYS);
      const caPem = this.#openssl(
        'make the CA certificate',
        [
          'req',
          '-x509',
          '-new',
          '-key',
          '/dev/stdin',
          DIGEST,
          '-days',
          days,
          '-subj',
          '/CN=amygdala local CA',
          '-addext',
          'basicConstraints=critical,CA:TRUE,pathlen:0',
          '-addext',
          'keyUsage=critical,keyCertSign',
        ],
        pem(ca.privateKey),
      );
      const caFile = join(dir, 'ca.pem');
      const requestFile = join(dir, 'host.csr');
      const extensionsFile = join(dir, 'host.ext');
      writeFileSync(caFile, caPem);
      writeFileSync(extensionsFile, hostExtensions(hosts));
      writeFileSync(
        requestFile,
        this.#openssl(
          'make the host request',
          ['req', '-new', '-key', '/dev/stdin', '-subj', '/CN=amygdala intercept'],
          pem(host.privateKey),
        ),
      );
      const certPem = this.#openssl(
        'sign the host certificate',
        [
          'x509',
          '-req',
          '-in',
          requestFile,
          '-CA',
          caFile,
          '-CAkey',
          '/dev/stdin',
          '-set_serial',
          `0x${randomBytes(SERIAL_BYTES).toString('hex')}`,
          DIGEST,
          '-days',
          days,
          '-extfile',
          extensionsFile,
        ],
        pem(ca.privateKey),
      );
      selfCheck(caPem, certPem, pem(host.privateKey), hosts);
      return {
        caPem,
        certPem,
        keyDer: new Uint8Array(host.privateKey.export({ type: 'pkcs8', format: 'der' })),
        notAfter: new Date(new X509Certificate(certPem).validTo),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // openssl's own message can quote what it was given, so errors carry the step and status only.
  #openssl(step: string, args: string[], input: string): string {
    const result = this.#run(OPENSSL, args, input);
    if (result.status !== 0) {
      throw new MintError(`openssl could not ${step} (exit ${String(result.status)})`);
    }
    // LibreSSL exits 0 even for an unknown command (measured 11-20), so the status alone can lie.
    if (!PEM_BLOCK.test(result.stdout)) {
      throw new MintError(`openssl could not ${step} (no PEM output)`);
    }
    return result.stdout;
  }
}
