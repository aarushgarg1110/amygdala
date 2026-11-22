import { createPrivateKey, X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, test } from 'vitest';
import type { Certificates } from '../src/certs.ts';
import {
  createInterceptor,
  defaultUpstreamCa,
  forwarder,
  type RequestHandler,
} from '../src/intercept.ts';
import { startProxy } from '../src/proxy.ts';
import { MINTER } from './deps.ts';

const HOST = 'api.anthropic.com';
const CLEANUP: (() => unknown)[] = [];
afterEach(async () => {
  for (const undo of CLEANUP.splice(0).reverse()) await undo();
});

const keyPem = (set: Certificates) =>
  createPrivateKey({ key: Buffer.from(set.keyDer), format: 'der', type: 'pkcs8' })
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();

// init's certificates (the client trusts their CA) and the "real" upstream's, from another CA.
const PROXY_CERTS = MINTER.mint([HOST]);
const UPSTREAM_CERTS = MINTER.mint([HOST]);

/** A local stand-in for the real host, recording what reaches it. */
async function upstream(answer: http.RequestListener, certs = UPSTREAM_CERTS) {
  const seen: { method: string | undefined; headers: http.IncomingHttpHeaders; body: Buffer }[] =
    [];
  const server = https.createServer(
    { key: keyPem(certs), cert: certs.certPem },
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({
          method: request.method,
          headers: request.headers,
          body: Buffer.concat(chunks),
        });
        answer(request, response);
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  CLEANUP.push(() => new Promise((resolve) => server.close(resolve)));
  return { port: (server.address() as net.AddressInfo).port, seen };
}

/** A proxy intercepting HOST, forwarding to `port` on localhost unless a handler is given. */
async function proxy(port: number, handler?: RequestHandler) {
  const intercept = createInterceptor({
    keyPem: keyPem(PROXY_CERTS),
    certPem: PROXY_CERTS.certPem,
    handler:
      handler ??
      forwarder({
        upstreamCa: [UPSTREAM_CERTS.caPem],
        resolve: () => ({ host: '127.0.0.1', port }),
      }),
  });
  const started = await startProxy({ interceptHosts: [HOST], intercept });
  CLEANUP.push(() => started.close());
  return started;
}

/** CONNECT through the proxy, then TLS to HOST trusting `ca`. */
async function secureThrough(proxyPort: number, ca = PROXY_CERTS.caPem, alpn?: string[]) {
  const raw = net.connect(proxyPort, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    raw.once('error', reject);
    raw.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`);
    raw.once('data', () => {
      resolve();
    });
  });
  const secure = tls.connect({
    socket: raw,
    servername: HOST,
    ca,
    ...(alpn ? { ALPNProtocols: alpn } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    secure.once('secureConnect', resolve);
    secure.once('error', reject);
  });
  CLEANUP.push(() => secure.destroy());
  return secure;
}

/** One HTTP request over `secure`, resolving with the reply and its body. */
function send(
  secure: tls.TLSSocket,
  options: http.RequestOptions,
  body?: Buffer,
  onChunk?: () => void,
) {
  return new Promise<{ reply: http.IncomingMessage; body: Buffer }>((resolve, reject) => {
    const request = http.request(
      {
        ...options,
        headers: { host: HOST, ...(options.headers as http.OutgoingHttpHeaders | undefined) },
        createConnection: () => secure,
      },
      (reply) => {
        const chunks: Buffer[] = [];
        reply.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          onChunk?.();
        });
        reply.on('end', () => {
          resolve({ reply, body: Buffer.concat(chunks) });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

describe('createInterceptor', () => {
  test('should forward a request unchanged and return the reply unchanged', async () => {
    // Assemble
    const up = await upstream((request, response) => {
      response.writeHead(201, { 'x-reply': 'yes' }).end('reply body');
    });
    const started = await proxy(up.port);

    // Act
    const { reply, body } = await send(await secureThrough(started.port), {
      method: 'GET',
      path: '/v1/models',
      headers: { 'x-ask': 'q' },
    });

    // Assert
    expect([reply.statusCode, reply.headers['x-reply'], body.toString()]).toEqual([
      201,
      'yes',
      'reply body',
    ]);
    expect(up.seen[0]?.headers['x-ask']).toBe('q');
    expect(up.seen[0]?.headers.host).toBe(HOST);
  });

  test('should forward a large body byte for byte', async () => {
    const up = await upstream((request, response) => response.end('ok'));
    const started = await proxy(up.port);
    const body = Buffer.from(JSON.stringify({ text: 'x'.repeat(200_000) }));
    await send(await secureThrough(started.port), { method: 'POST', path: '/v1/messages' }, body);
    expect(up.seen[0]?.body.equals(body)).toBe(true);
  });

  test('should stream a reply as it arrives', async () => {
    // Assemble: the upstream holds its reply open until the client has seen the first event
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const up = await upstream((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: one\ndata: {}\n\n');
      void held.then(() => response.end('event: two\ndata: {}\n\n'));
    });
    const started = await proxy(up.port);

    // Act: the first chunk releases the upstream, which only works if it wasn't buffered
    const { body } = await send(
      await secureThrough(started.port),
      { method: 'GET', path: '/s' },
      undefined,
      release,
    );

    // Assert
    expect(body.toString()).toBe('event: one\ndata: {}\n\nevent: two\ndata: {}\n\n');
  });

  test('should forward two requests on one connection', async () => {
    const up = await upstream((request, response) => response.end(request.url));
    const started = await proxy(up.port);
    const secure = await secureThrough(started.port);
    const options = { method: 'GET', headers: { connection: 'keep-alive' } };
    const first = await send(secure, { ...options, path: '/one' });
    const second = await send(secure, { ...options, path: '/two' });
    expect([first.body.toString(), second.body.toString()]).toEqual(['/one', '/two']);
  });

  test('should drop hop-by-hop headers and keep the rest', async () => {
    // Assemble
    const up = await upstream((request, response) => {
      response
        .writeHead(200, { 'keep-alive': 'timeout=5', 'x-kept': 'reply', trailer: 'x-t' })
        .end('ok');
    });
    const started = await proxy(up.port);

    // Act
    const { reply } = await send(await secureThrough(started.port), {
      method: 'GET',
      path: '/',
      headers: {
        'anthropic-beta': 'oauth-2025-04-20',
        authorization: 'Bearer t',
        te: 'trailers',
        'proxy-connection': 'keep-alive',
      },
    });

    // Assert
    const asked = up.seen[0]?.headers ?? {};
    expect([asked['anthropic-beta'], asked.authorization]).toEqual([
      'oauth-2025-04-20',
      'Bearer t',
    ]);
    expect([asked.te, asked['proxy-connection']]).toEqual([undefined, undefined]);
    expect([reply.headers['x-kept'], reply.headers['keep-alive'], reply.headers.trailer]).toEqual([
      'reply',
      undefined,
      undefined,
    ]);
  });

  test.each([
    ['a certificate from an untrusted CA', () => PROXY_CERTS, [UPSTREAM_CERTS.caPem]],
    ['a certificate for another name', () => MINTER.mint(['evil.example']), undefined],
  ])(
    'should refuse an upstream it cannot verify, before sending anything: %s',
    async (label, certsOf, ca) => {
      // Assemble
      const certs = certsOf();
      const up = await upstream((request, response) => response.end('should not happen'), certs);
      const handler = forwarder({
        upstreamCa: ca ?? [certs.caPem],
        resolve: () => ({ host: '127.0.0.1', port: up.port }),
      });
      const started = await proxy(up.port, handler);

      // Act
      const { reply } = await send(
        await secureThrough(started.port),
        { method: 'POST', path: '/' },
        Buffer.from('secret'),
      );

      // Assert
      expect(reply.statusCode).toBe(502);
      expect(up.seen).toEqual([]);
    },
  );

  test('should answer 502 when the upstream refuses', async () => {
    const spare = net.createServer();
    await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve));
    const dead = (spare.address() as net.AddressInfo).port;
    await new Promise((resolve) => spare.close(resolve));
    const started = await proxy(dead);
    const { reply } = await send(await secureThrough(started.port), { method: 'GET', path: '/' });
    expect(reply.statusCode).toBe(502);
  });

  test("should fail the handshake for a client that doesn't trust the CA", async () => {
    const up = await upstream((request, response) => response.end('no'));
    const started = await proxy(up.port);
    await expect(secureThrough(started.port, UPSTREAM_CERTS.caPem)).rejects.toThrow();
    expect(up.seen).toEqual([]);
  });

  test('should never speak HTTP/2', async () => {
    const up = await upstream((request, response) => response.end('ok'));
    const started = await proxy(up.port);
    const outcome = await secureThrough(started.port, PROXY_CERTS.caPem, ['h2']).then(
      (secure) => secure.alpnProtocol,
      () => 'refused',
    );
    expect(outcome).not.toBe('h2');
  });

  test('should let a custom handler answer on its own', async () => {
    const up = await upstream((request, response) => response.end('upstream'));
    const started = await proxy(up.port, (request, response, target) => {
      response.writeHead(400).end(`blocked for ${target.host}:${String(target.port)}`);
    });
    const { reply, body } = await send(await secureThrough(started.port), {
      method: 'GET',
      path: '/',
    });
    expect([reply.statusCode, body.toString()]).toEqual([400, `blocked for ${HOST}:443`]);
    expect(up.seen).toEqual([]);
  });

  test('should trust the system store and the bundled CAs by default', () => {
    const fingerprints = new Set(
      defaultUpstreamCa().map((pem) => new X509Certificate(pem).fingerprint256),
    );
    for (const pem of [...tls.getCACertificates('system'), ...tls.getCACertificates('bundled')]) {
      expect(fingerprints.has(new X509Certificate(pem).fingerprint256)).toBe(true);
    }
  });
});
