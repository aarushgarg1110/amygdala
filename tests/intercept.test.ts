import { X509Certificate } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { afterEach, describe, expect, test } from 'vitest';
import { defaultUpstreamCa, forwarder, type RequestHandler } from '../src/intercept.ts';
import { MINTER } from './deps.ts';
import {
  cleanup,
  CLEANUP,
  connectTo,
  handshake,
  HOST,
  localForwarder,
  PROXY_CERTS,
  proxyWith,
  secureThrough,
  send,
  UPSTREAM_CERTS,
  upstream,
} from './harness.ts';

afterEach(cleanup);

/** A TCP relay to `port` that can cut its connections from the proxy (FIN or RST) on demand. */
async function cuttingRelay(port: number) {
  const fromProxy: net.Socket[] = [];
  const relay = net.createServer((socket) => {
    fromProxy.push(socket);
    const onward = net.connect(port, '127.0.0.1');
    socket.pipe(onward);
    onward.pipe(socket);
    socket.on('error', () => onward.destroy());
    socket.on('close', () => onward.destroy());
    onward.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  CLEANUP.push(() => new Promise((resolve) => relay.close(resolve)));
  return {
    port: (relay.address() as net.AddressInfo).port,
    cut: (how: (socket: net.Socket) => void) => {
      for (const socket of fromProxy) how(socket);
    },
  };
}

/** A proxy intercepting `host`, forwarding to `port` on localhost unless a handler is given. */
async function proxy(
  port: number,
  handler?: RequestHandler | 'default',
  { host = HOST, certs = PROXY_CERTS } = {},
) {
  return proxyWith(handler === 'default' ? undefined : (handler ?? localForwarder(port)), {
    hosts: [host],
    certs,
  });
}

/**
 * Like secureThrough, but the TLS ClientHello goes out in the same write as the CONNECT, so the
 * proxy receives it as early bytes before it has answered.
 */
async function secureWithEarlyBytes(proxyPort: number) {
  const raw = net.connect(proxyPort, '127.0.0.1');
  CLEANUP.push(() => raw.destroy());
  let sent = false;
  let answered = false;
  let pending = Buffer.alloc(0);
  const bridge = new Duplex({
    read: () => undefined,
    write(chunk: Buffer, encoding, done) {
      raw.write(sent ? chunk : Buffer.concat([Buffer.from(connectTo(HOST, 443)), chunk]), done);
      sent = true;
    },
  });
  // The proxy's "200 Connection Established" is consumed here; everything after it is TLS.
  raw.on('data', (chunk: Buffer) => {
    if (answered) {
      bridge.push(chunk);
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf('\r\n\r\n');
    if (end === -1) return;
    answered = true;
    bridge.push(pending.subarray(end + 4));
  });
  return handshake(tls.connect({ socket: bridge, servername: HOST, ca: PROXY_CERTS.caPem }));
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
    expect(up.seen[0]?.servername).toBe(HOST);
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

  test('should forward to the CONNECT target itself, trusting only the default CAs, with no handler', async () => {
    // Assemble: a local "real host" whose CA is in neither the system nor the bundled store
    const certs = MINTER.mint(['localhost']);
    const up = await upstream((request, response) => response.end('should not happen'), certs);
    const started = await proxy(up.port, 'default', { host: 'localhost', certs });

    // Act
    const secure = await secureThrough(started.port, certs.caPem, undefined, {
      host: 'localhost',
      port: up.port,
    });
    const { reply } = await send(secure, { method: 'POST', path: '/' }, Buffer.from('secret'));

    // Assert: it reached the target's own port, refused the certificate, and sent nothing
    expect(reply.statusCode).toBe(502);
    expect(up.connections()).toBeGreaterThan(0);
    expect(up.seen).toEqual([]);
  });

  test.each([
    ['closes', (socket: net.Socket) => socket.destroy()],
    ['resets', (socket: net.Socket) => socket.resetAndDestroy()],
  ])(
    'should cut the client off, not answer 502, when the upstream %s partway through a reply',
    async (label, cut) => {
      // Assemble: the upstream sends one event and holds; a relay in front of it does the cutting
      const up = await upstream((request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('event: one\n\n');
      });
      const relay = await cuttingRelay(up.port);
      const started = await proxy(
        0,
        forwarder({
          upstreamCa: [UPSTREAM_CERTS.caPem],
          resolve: () => ({ host: '127.0.0.1', port: relay.port }),
        }),
      );
      const secure = await secureThrough(started.port);

      // Act: once the first event is through, the upstream connection goes away
      const outcome = await new Promise<{
        status: number | undefined;
        body: string;
        complete: boolean;
      }>((resolve, reject) => {
        const request = http.request(
          { method: 'GET', path: '/', headers: { host: HOST }, createConnection: () => secure },
          (reply) => {
            const chunks: Buffer[] = [];
            reply.on('data', (chunk: Buffer) => {
              chunks.push(chunk);
              relay.cut(cut);
            });
            reply.on('close', () => {
              resolve({
                status: reply.statusCode,
                body: Buffer.concat(chunks).toString(),
                complete: reply.complete,
              });
            });
          },
        );
        request.on('error', reject);
        request.end();
      });

      // Assert
      expect(outcome).toEqual({ status: 200, body: 'event: one\n\n', complete: false });
    },
  );

  test('should accept a ClientHello that arrives with the CONNECT', async () => {
    const up = await upstream((request, response) => response.end('ok'));
    const started = await proxy(up.port);
    const secure = await secureWithEarlyBytes(started.port);
    const { body } = await send(secure, { method: 'GET', path: '/' });
    expect(started.heads[0]).toBeGreaterThan(0);
    expect(body.toString()).toBe('ok');
  });
});
