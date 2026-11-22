import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

/** The only address the proxy listens on: nothing off this machine can reach it (4.5). */
export const LISTEN_HOST = '127.0.0.1';
const MAX_PORT = 65_535;
// A host name or an IPv4 address, then a port: anything else is refused, never guessed at.
const TARGET = /^([a-z0-9.-]+):(\d{1,5})$/i;

/**
 * Takes over a client's CONNECT to an intercept host: nothing has been answered yet, and `head`
 * holds any bytes that arrived with the request.
 */
export type Intercept = (host: string, port: number, client: Duplex, head: Buffer) => void;

export interface ProxyOptions {
  /** 0, the default, picks a free port. */
  readonly port?: number;
  readonly interceptHosts: readonly string[];
  readonly intercept: Intercept;
}

export interface Proxy {
  readonly host: string;
  readonly port: number;
  /** Stops listening and ends every open connection. */
  close(): Promise<void>;
}

/** `host:port` from a CONNECT request, the host in lower case; undefined when malformed. */
export function parseTarget(target: string): { host: string; port: number } | undefined {
  const match = TARGET.exec(target);
  if (match === null) return undefined;
  const [, host = '', digits = ''] = match;
  const port = Number(digits);
  if (port < 1 || port > MAX_PORT) return undefined;
  return { host: host.toLowerCase(), port };
}

/**
 * The proxy Claude Code reaches through HTTPS_PROXY. A CONNECT to an intercept host goes to
 * `intercept`, whatever the port, so it is never tunneled untouched; every other host gets a raw
 * tunnel whose bytes are never decrypted or changed (3.5).
 */
export async function startProxy(options: ProxyOptions): Promise<Proxy> {
  const intercepted = new Set(options.interceptHosts.map((host) => host.toLowerCase()));
  const open = new Set<Duplex>();
  const track = (socket: Duplex) => {
    open.add(socket);
    // A peer hanging up mid-stream must not crash the proxy.
    socket.on('error', () => socket.destroy());
    socket.on('close', () => open.delete(socket));
  };

  // HTTPS_PROXY only ever sends CONNECT; anything else is unexpected and forwarded nowhere.
  const server = http.createServer((request, response) => {
    response.writeHead(405, { allow: 'CONNECT' }).end();
  });
  // A request Node's parser can't even read (a space in the target, say) is malformed too.
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy(error);
  });
  server.on('connect', (request: http.IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    // Node always gives a CONNECT its target; were it ever missing, "undefined" fails the parse.
    const target = parseTarget(String(request.url));
    if (target === undefined) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (intercepted.has(target.host)) {
      options.intercept(target.host, target.port, client, head);
      return;
    }
    tunnel(target.host, target.port, client, head, track);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, LISTEN_HOST, resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    host: LISTEN_HOST,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

// 200 only once the upstream has connected, so a refused host gets a 502 instead of a dead tunnel.
function tunnel(
  host: string,
  port: number,
  client: Duplex,
  head: Buffer,
  track: (socket: Duplex) => void,
) {
  const upstream = net.connect(port, host);
  track(upstream);
  let connected = false;
  upstream.once('connect', () => {
    connected = true;
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.once('error', () => {
    if (!connected) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  // Either side going away ends the other, so nothing is left half open. Before the upstream
  // connected, the client is already being sent its 502 and closes on its own.
  upstream.once('close', () => {
    if (connected) client.destroy();
  });
  client.once('close', () => upstream.destroy());
}
