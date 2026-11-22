import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import { LISTEN_HOST, startProxy, type Intercept, type Proxy } from '../src/proxy.ts';

const CLEANUP: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const undo of CLEANUP.splice(0).reverse()) await undo();
});

/** A local echo server that counts its connections and lets tests watch them close. */
async function echoServer() {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => socket.destroy());
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  CLEANUP.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { port: (server.address() as net.AddressInfo).port, sockets };
}

/** A proxy intercepting `hosts`, whose hook records each call and ends the client. */
async function proxy(hosts: readonly string[] = ['api.anthropic.com']) {
  const calls: { host: string; port: number }[] = [];
  const intercept: Intercept = (host, port, client) => {
    calls.push({ host, port });
    client.end('HTTP/1.1 418 Intercepted\r\n\r\n');
  };
  const started: Proxy = await startProxy({ interceptHosts: hosts, intercept });
  CLEANUP.push(() => started.close());
  return { proxy: started, calls };
}

/** Sends CONNECT for `target` (plus `head`) and resolves with the status line and the socket. */
function connectThrough(port: number, target: string, head = Buffer.alloc(0)) {
  return new Promise<{ status: string; socket: net.Socket; rest: Buffer }>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', reject);
    socket.on('close', () => {
      reject(new Error('closed before any response'));
    });
    socket.write(
      Buffer.concat([Buffer.from(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`), head]),
    );
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      resolve({
        status: received.subarray(0, received.indexOf('\r\n')).toString(),
        socket,
        rest: received.subarray(end + 4),
      });
    };
    socket.on('data', onData);
  });
}

/** Reads `length` bytes from `socket`, starting with what already arrived. */
function readBytes(socket: net.Socket, length: number, already: Buffer = Buffer.alloc(0)) {
  return new Promise<Buffer>((resolve) => {
    let received: Buffer = already;
    if (received.length >= length) {
      resolve(received);
      return;
    }
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= length) resolve(received);
    });
  });
}

const closed = (socket: net.Socket) =>
  new Promise<void>((resolve) => {
    if (socket.destroyed) resolve();
    else
      socket.once('close', () => {
        resolve();
      });
  });

describe('startProxy', () => {
  test('should listen on 127.0.0.1 only and report its port', async () => {
    // Act
    const { proxy: started } = await proxy();

    // Assert: loopback answers; this machine's other addresses don't
    expect([started.host, started.port > 0]).toEqual([LISTEN_HOST, true]);
    const outside = Object.values(networkInterfaces())
      .flat()
      .find((address) => address?.family === 'IPv4' && !address.internal)?.address;
    if (outside !== undefined) {
      await expect(
        new Promise((resolve, reject) => {
          const socket = net.connect(started.port, outside, () => {
            socket.destroy();
            resolve('connected');
          });
          socket.on('error', (error: NodeJS.ErrnoException) => {
            reject(error);
          });
        }),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    }
  });

  test('should tunnel a host it does not intercept, bytes unchanged', async () => {
    // Assemble
    const echo = await echoServer();
    const { proxy: started } = await proxy();

    // Act: the first bytes ride along with the CONNECT itself
    const { status, socket, rest } = await connectThrough(
      started.port,
      `127.0.0.1:${String(echo.port)}`,
      Buffer.from('early '),
    );
    socket.write('later');
    const echoed = await readBytes(socket, 'early later'.length, rest);
    socket.destroy();

    // Assert
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    expect(echoed.toString()).toBe('early later');
  });

  test('should pass a megabyte of binary through unchanged', async () => {
    // Assemble
    const echo = await echoServer();
    const { proxy: started } = await proxy();
    const payload = randomBytes(1024 * 1024);

    // Act
    const { socket, rest } = await connectThrough(started.port, `127.0.0.1:${String(echo.port)}`);
    socket.write(payload);
    const echoed = await readBytes(socket, payload.length, rest);
    socket.destroy();

    // Assert
    expect(echoed.equals(payload)).toBe(true);
  });

  test('should answer 502 when the upstream refuses, and keep serving', async () => {
    // Assemble: a port nothing listens on
    const spare = net.createServer();
    await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve));
    const deadPort = (spare.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) =>
      spare.close(() => {
        resolve();
      }),
    );
    const echo = await echoServer();
    const { proxy: started } = await proxy();

    // Act
    const refused = await connectThrough(started.port, `127.0.0.1:${String(deadPort)}`);
    await closed(refused.socket);
    const next = await connectThrough(started.port, `127.0.0.1:${String(echo.port)}`);
    next.socket.destroy();

    // Assert
    expect(refused.status).toBe('HTTP/1.1 502 Bad Gateway');
    expect(next.status).toBe('HTTP/1.1 200 Connection Established');
  });

  test('should refuse anything but CONNECT with 405', async () => {
    // Assemble
    const echo = await echoServer();
    const { proxy: started } = await proxy();

    // Act: a plain proxied GET for the echo server
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port: started.port, path: `http://127.0.0.1:${String(echo.port)}/` },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        )
        .on('error', reject);
    });

    // Assert: refused, and nothing reached the target
    expect(status).toBe(405);
    expect(echo.sockets).toHaveLength(0);
  });

  test.each([
    'api.anthropic.com',
    'host:port',
    'host:0',
    'host:65536',
    ':443',
    'a b:443',
    '[::1]:443',
  ])('should refuse a malformed target with 400: %s', async (target) => {
    const { proxy: started, calls } = await proxy();
    const { status, socket } = await connectThrough(started.port, target);
    socket.destroy();
    expect(status).toBe('HTTP/1.1 400 Bad Request');
    expect(calls).toEqual([]);
  });

  test.each([
    ['api.anthropic.com:443', 'api.anthropic.com', 443],
    ['API.Anthropic.com:443', 'api.anthropic.com', 443],
    ['api.anthropic.com:8443', 'api.anthropic.com', 8443],
  ])(
    'should hand an intercept host to the hook and never tunnel it: %s',
    async (target, host, port) => {
      // Act
      const { proxy: started, calls } = await proxy();
      const { status, socket } = await connectThrough(started.port, target);
      socket.destroy();

      // Assert
      expect(status).toBe('HTTP/1.1 418 Intercepted');
      expect(calls).toEqual([{ host, port }]);
    },
  );

  test('should never open a tunnel to a host it intercepts', async () => {
    // Assemble: the echo server's own address is on the intercept list
    const echo = await echoServer();
    const { proxy: started, calls } = await proxy(['127.0.0.1']);

    // Act
    const { status, socket } = await connectThrough(started.port, `127.0.0.1:${String(echo.port)}`);
    socket.destroy();

    // Assert: the hook had it, and the echo server never saw a connection
    expect(status).toBe('HTTP/1.1 418 Intercepted');
    expect(calls).toHaveLength(1);
    expect(echo.sockets).toHaveLength(0);
  });

  test.each(['client', 'upstream', 'client, with a reset'] as const)(
    'should close one side of a tunnel when the other hangs up: the %s',
    async (who) => {
      // Assemble
      const echo = await echoServer();
      const { proxy: started } = await proxy();
      const { socket, rest } = await connectThrough(started.port, `127.0.0.1:${String(echo.port)}`);
      socket.write('x');
      await readBytes(socket, 1, rest);
      const upstream = echo.sockets[0];
      if (upstream === undefined) throw new Error('no upstream connection');

      // Act: a reset (RST) passes no end down the pipe, unlike a polite close
      if (who === 'upstream') upstream.destroy();
      else if (who === 'client') socket.destroy();
      else socket.resetAndDestroy();

      // Assert: the other side closes too
      await closed(who === 'upstream' ? socket : upstream);
    },
  );

  test('should close the client without a 502 when the upstream resets mid-tunnel', async () => {
    // Assemble: an open tunnel
    const echo = await echoServer();
    const { proxy: started } = await proxy();
    const { socket, rest } = await connectThrough(started.port, `127.0.0.1:${String(echo.port)}`);
    socket.write('x');
    await readBytes(socket, 1, rest);
    let after = '';
    socket.on('data', (chunk: Buffer) => {
      after += chunk.toString();
    });

    // Act: the upstream resets instead of closing
    echo.sockets[0]?.resetAndDestroy();
    await closed(socket);

    // Assert: nothing was injected into the tunnel's byte stream
    expect(after).toBe('');
  });

  test('should survive a client that resets in the middle of its request', async () => {
    // Assemble
    const echo = await echoServer();
    const { proxy: started } = await proxy();

    // Act: half a request line, then a reset instead of a polite close
    const rude = net.connect(started.port, '127.0.0.1');
    rude.on('error', () => undefined);
    await new Promise<void>((resolve) =>
      rude.once('connect', () => {
        resolve();
      }),
    );
    rude.write('CONNECT 127.0.0.1:');
    await new Promise((resolve) => setTimeout(resolve, 50));
    rude.resetAndDestroy();
    await closed(rude);
    const next = await connectThrough(started.port, `127.0.0.1:${String(echo.port)}`);
    next.socket.destroy();

    // Assert: the proxy kept serving
    expect(next.status).toBe('HTTP/1.1 200 Connection Established');
  });

  test('should stop listening and end open tunnels on close', async () => {
    // Assemble
    const echo = await echoServer();
    const started = await startProxy({ interceptHosts: [], intercept: () => undefined });
    const { socket } = await connectThrough(started.port, `127.0.0.1:${String(echo.port)}`);

    // Act
    await started.close();

    // Assert
    await closed(socket);
    await expect(connectThrough(started.port, '127.0.0.1:1')).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });
});
