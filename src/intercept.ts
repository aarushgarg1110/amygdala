import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import tls from 'node:tls';
import type { Intercept } from './proxy.ts';

/** Where a decrypted request was headed. */
export interface Target {
  readonly host: string;
  readonly port: number;
}

/** Answers one decrypted request: the default forwards it; B3's rewrites, restores or blocks. */
export type RequestHandler = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  target: Target,
) => void;

/** Sends a request upstream: its own body, or `body` when a handler has already read and changed it. */
export type Forward = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  target: Target,
  body?: Buffer,
) => void;

// Hop-by-hop headers describe one connection, so they never cross the proxy.
const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
]);

/** `headers` without hop-by-hop ones; everything else passes, `anthropic-beta` included (R1). */
export function withoutHopByHop(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())),
  );
}

/** What an upstream certificate must chain to: the system store (with any TLS-inspection root) and Node's bundled CAs. */
export const defaultUpstreamCa = (): string[] => [
  ...tls.getCACertificates('bundled'),
  ...tls.getCACertificates('system'),
];

/** A reply from the upstream: Node's client parser sets the status of every response it emits. */
type UpstreamReply = http.IncomingMessage & { readonly statusCode: number };

export interface ForwardOptions {
  readonly upstreamCa?: readonly string[];
  /** Where to connect for a target: the target itself by default; tests point it at localhost. */
  readonly resolve?: (target: Target) => Target;
}

/**
 * The pass-through handler: the request goes to the real host unchanged and the reply streams
 * back as it arrives. The upstream is checked against the target's name before anything is sent,
 * and one that fails gets a 502.
 */
export function forwarder(options: ForwardOptions = {}): Forward {
  const agent = new https.Agent({
    keepAlive: true,
    ca: [...(options.upstreamCa ?? defaultUpstreamCa())],
  });
  const resolve = options.resolve ?? ((target: Target) => target);
  return (request, response, target, body) => {
    const to = resolve(target);
    const headers = withoutHopByHop(request.headers);
    // A replaced body has its own length; a request that had no body doesn't gain the header.
    if (body !== undefined && (body.length > 0 || headers['content-length'] !== undefined)) {
      headers['content-length'] = String(body.length);
    }
    const upstream = https.request({
      host: to.host,
      port: to.port,
      servername: target.host,
      checkServerIdentity: (name, cert) => tls.checkServerIdentity(target.host, cert),
      method: request.method,
      path: request.url,
      headers,
      agent,
    });
    upstream.on('response', (reply: UpstreamReply) => {
      response.writeHead(reply.statusCode, withoutHopByHop(reply.headers));
      // Not pipe: an upstream dying mid-reply must cut the client off, never leave it waiting.
      pipeline(reply, response, () => undefined);
    });
    upstream.on('error', () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    });
    if (body === undefined) request.pipe(upstream);
    else upstream.end(body);
  };
}

export interface InterceptOptions {
  /** `init`'s host certificate and key (loadCertificates). */
  readonly keyPem: string;
  readonly certPem: string;
  readonly handler?: RequestHandler;
}

/**
 * B2a's hook for intercept hosts: answers the CONNECT, terminates TLS with the host certificate,
 * offering HTTP/1.1 only, and gives each decrypted request to the handler.
 */
export function createInterceptor(options: InterceptOptions): Intercept {
  const secureContext = tls.createSecureContext({ key: options.keyPem, cert: options.certPem });
  const handler = options.handler ?? forwarder();
  return (host, port, client, head) => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) client.unshift(head);
    const secure = new tls.TLSSocket(client, {
      isServer: true,
      secureContext,
      ALPNProtocols: ['http/1.1'],
    });
    secure.on('error', () => secure.destroy());
    const server = http.createServer((request, response) => {
      handler(request, response, { host, port });
    });
    server.emit('connection', secure);
  };
}
