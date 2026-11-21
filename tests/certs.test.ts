import { createPrivateKey, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import tls from 'node:tls';
import { beforeAll, describe, expect, test } from 'vitest';
import { CERT_DAYS, MintError, OpensslMinter, type Certificates } from '../src/certs.ts';
import { DEFAULT_INTERCEPT_HOSTS as HOSTS } from '../src/config.ts';
import { runProcess, type Run } from '../src/process.ts';

const DAY_MS = 86_400_000;
const STEPS = ['make the CA certificate', 'make the host request', 'sign the host certificate'];

/** openssl's text form of a certificate, for the extensions Node doesn't expose. */
const certificateText = (pem: string) =>
  runProcess('/usr/bin/openssl', ['x509', '-noout', '-text'], pem).stdout;

const keyPem = (der: Uint8Array) =>
  createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' })
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();

/** The value after `flag` in `args`. */
const after = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1] ?? '';

/** A real openssl that lets `tamper` change one step's arguments or input first. */
function tampered(
  step: number,
  tamper: (args: string[], input: string) => { args: string[]; input: string },
): Run {
  let call = 0;
  return (command, args, input = '') => {
    const changed = call === step ? tamper([...args], input) : { args: [...args], input };
    call += 1;
    return runProcess(command, changed.args, changed.input);
  };
}

/** Connects to a TLS server presenting `certs`, trusting only their CA, as `servername`. */
async function handshake(certs: Certificates, servername: string): Promise<string> {
  const server = tls.createServer({ key: keyPem(certs.keyDer), cert: certs.certPem }, (socket) => {
    socket.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<string>((resolve, reject) => {
      let reply = '';
      const socket = tls.connect({ host: '127.0.0.1', port, servername, ca: certs.caPem });
      socket.on('data', (chunk: Buffer) => (reply += chunk.toString()));
      socket.on('end', () => {
        resolve(reply);
      });
      socket.on('error', reject);
    });
  } finally {
    server.close();
  }
}

describe('OpensslMinter', () => {
  let certs: Certificates;
  beforeAll(() => {
    certs = new OpensslMinter().mint(HOSTS);
  });

  test('should make a CA and a host certificate for exactly the given hosts', () => {
    // Act
    const ca = new X509Certificate(certs.caPem);
    const cert = new X509Certificate(certs.certPem);

    // Assert
    expect([ca.ca, cert.ca]).toEqual([true, false]);
    expect(certificateText(certs.caPem)).toMatch(/CA:TRUE, pathlen:0/);
    expect(certificateText(certs.caPem)).toMatch(/Key Usage: critical\s+Certificate Sign\n/);
    expect(cert.subjectAltName).toBe(HOSTS.map((host) => `DNS:${host}`).join(', '));
    expect(certificateText(certs.certPem)).toMatch(/TLS Web Server Authentication/);
    expect([ca.signatureAlgorithm, cert.signatureAlgorithm]).toEqual([
      'ecdsa-with-SHA256',
      'ecdsa-with-SHA256',
    ]);
    const days = (certs.notAfter.getTime() - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(CERT_DAYS - 1);
    expect(days).toBeLessThanOrEqual(CERT_DAYS);
    expect(Math.abs(new Date(ca.validTo).getTime() - certs.notAfter.getTime())).toBeLessThan(
      60_000,
    );
  });

  test('should cover each host and no other, signed by the CA', () => {
    // Act
    const cert = new X509Certificate(certs.certPem);

    // Assert
    expect(cert.verify(new X509Certificate(certs.caPem).publicKey)).toBe(true);
    expect(HOSTS.map((host) => cert.checkHost(host))).toEqual(HOSTS);
    expect(cert.checkHost('evil.example')).toBeUndefined();
    expect(cert.checkHost('x.api.anthropic.com')).toBeUndefined();
  });

  test("should give a key and certificate Node's TLS loads", async () => {
    // Act and Assert: a real handshake that trusts only the new CA, as protected sessions will
    await expect(handshake(certs, 'api.anthropic.com')).resolves.toBe('ok');
    await expect(handshake(certs, 'evil.example')).rejects.toMatchObject({
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
  });

  test('should hand openssl private keys only on stdin and leave no folder behind', () => {
    // Assemble: a real openssl that records each call and, at the signing step, every file it sees
    const calls: { args: readonly string[]; input: string | undefined }[] = [];
    let filesWhileSigning = '';
    const run: Run = (command, args, input) => {
      calls.push({ args, input });
      if (args.includes('-CAkey')) {
        const folder = dirname(after(args, '-in'));
        filesWhileSigning = readdirSync(folder)
          .map((name) => readFileSync(join(folder, name), 'utf8'))
          .join('\n');
      }
      return runProcess(command, args, input);
    };

    // Act
    new OpensslMinter({ run }).mint(HOSTS);

    // Assert
    expect(calls).toHaveLength(3);
    for (const { args, input } of calls) {
      expect(input).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
      expect(args.join(' ')).not.toMatch(/PRIVATE KEY|-keyout|\.key\b/);
    }
    expect(calls[2]?.input).toBe(calls[0]?.input);
    expect(filesWhileSigning).toContain('BEGIN CERTIFICATE');
    expect(filesWhileSigning).not.toContain('PRIVATE KEY');
    expect(existsSync(dirname(after(calls[2]?.args ?? [], '-in')))).toBe(false);
  });

  test('should make a new CA and serial every time', () => {
    // Act
    const other = new OpensslMinter().mint(HOSTS);

    // Assert
    const key = (pem: string) =>
      new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'pem' });
    expect(key(other.caPem)).not.toBe(key(certs.caPem));
    expect(new X509Certificate(other.certPem).serialNumber).not.toBe(
      new X509Certificate(certs.certPem).serialNumber,
    );
  });

  test.each(
    STEPS.flatMap((step, index) => [
      [`${step}, exit 1`, index, 1, '', `openssl could not ${step} (exit 1)`] as const,
      // LibreSSL exits 0 even for an unknown command, so the output is checked too.
      [
        `${step}, exit 0 and no output`,
        index,
        0,
        '',
        `openssl could not ${step} (no PEM output)`,
      ] as const,
    ]),
  )('should name the step when openssl fails: %s', (label, index, status, stdout, message) => {
    // Assemble: a real openssl until the failing step
    let call = 0;
    const run: Run = (command, args, input) =>
      call++ === index ? { status, stdout, stderr: 'boom' } : runProcess(command, args, input);

    // Act and Assert
    expect(() => new OpensslMinter({ run }).mint(HOSTS)).toThrow(new MintError(message));
  });

  test('should refuse a certificate it cannot read', () => {
    // Assemble: the signing step answers with a PEM block that holds no certificate
    let call = 0;
    const run: Run = (command, args, input) =>
      call++ === 2
        ? {
            status: 0,
            stdout: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
            stderr: '',
          }
        : runProcess(command, args, input);

    // Act and Assert
    expect(() => new OpensslMinter({ run }).mint(HOSTS)).toThrow(
      new MintError('the new certificates could not be read'),
    );
  });

  test.each([
    [
      'a CA that is not a CA',
      tampered(0, (args, input) => ({
        args: args.map((arg) =>
          arg.startsWith('basicConstraints') ? 'basicConstraints=CA:FALSE' : arg,
        ),
        input,
      })),
      'the CA certificate is not a CA',
    ],
    [
      'a certificate signed by another CA',
      tampered(2, (args) => {
        // A second CA with the same name: only its key differs.
        const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
        const otherPem = other.export({ type: 'pkcs8', format: 'pem' }).toString();
        const otherCa = runProcess(
          '/usr/bin/openssl',
          [
            'req',
            '-x509',
            '-new',
            '-key',
            '/dev/stdin',
            '-sha256',
            '-days',
            '1',
            '-subj',
            '/CN=amygdala local CA',
          ],
          otherPem,
        ).stdout;
        writeFileSync(after(args, '-CA'), otherCa);
        return { args, input: otherPem };
      }),
      'the host certificate is not signed by the CA',
    ],
    [
      'a missing host',
      tampered(2, (args, input) => {
        const file = after(args, '-extfile');
        writeFileSync(file, readFileSync(file, 'utf8').replace(',DNS:claude.ai', ''));
        return { args, input };
      }),
      "it doesn't cover claude.ai",
    ],
    [
      'a certificate with no host names',
      tampered(2, (args, input) => {
        const file = after(args, '-extfile');
        writeFileSync(file, readFileSync(file, 'utf8').replace(/^subjectAltName=.*\n/, ''));
        return { args, input };
      }),
      `it doesn't cover ${HOSTS.join(', ')}`,
    ],
    [
      'an extra host',
      tampered(2, (args, input) => {
        const file = after(args, '-extfile');
        writeFileSync(
          file,
          readFileSync(file, 'utf8').replace('DNS:claude.ai', 'DNS:claude.ai,DNS:evil.example'),
        );
        return { args, input };
      }),
      'it also covers evil.example',
    ],
    [
      'a SHA-1 signature',
      tampered(2, (args, input) => ({
        args: args.map((arg) => (arg === '-sha256' ? '-sha1' : arg)),
        input,
      })),
      'the host certificate is signed with ecdsa-with-SHA1',
    ],
    [
      'a certificate for another key',
      tampered(1, (args) => ({
        args,
        input: generateKeyPairSync('ec', { namedCurve: 'P-256' })
          .privateKey.export({ type: 'pkcs8', format: 'pem' })
          .toString(),
      })),
      "Node's TLS can't use them",
    ],
  ])('should refuse certificates that fail the self-check: %s', (label, run, problem) => {
    expect(() => new OpensslMinter({ run }).mint(HOSTS)).toThrow(problem);
    expect(() =>
      new OpensslMinter({ run: tampered(-1, (a, i) => ({ args: a, input: i })) }).mint(HOSTS),
    ).not.toThrow();
  });

  test('should refuse an empty host list before running openssl', () => {
    // Assemble
    const calls: string[] = [];
    const run: Run = (command) => {
      calls.push(command);
      return { status: 0, stdout: '', stderr: '' };
    };

    // Act and Assert
    expect(() => new OpensslMinter({ run }).mint([])).toThrow(
      new MintError('no hosts to make a certificate for'),
    );
    expect(calls).toEqual([]);
  });
});
