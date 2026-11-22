// Real local TLS on both sides of the proxy, for tests of what the intercept handlers send and return.
import { createPrivateKey } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Certificates } from '../src/certs.ts';
import { buildDetectors } from '../src/engine/detector.ts';
import { TokenMap } from '../src/engine/token-map.ts';
import { createInterceptor, forwarder, type RequestHandler } from '../src/intercept.ts';
import { startProxy } from '../src/proxy.ts';
import { MINTER } from './deps.ts';

export const HOST = 'api.anthropic.com';
export const DATADOG = 'http-intake.logs.us5.datadoghq.com';
const HOSTS = [HOST, 'claude.ai', DATADOG];

/** Undo steps for what a test started; each test file runs `cleanup` after every test. */
export const CLEANUP: (() => unknown)[] = [];
export async function cleanup() {
  for (const undo of CLEANUP.splice(0).reverse()) await undo();
}

export const keyPem = (set: Certificates) =>
  createPrivateKey({ key: Buffer.from(set.keyDer), format: 'der', type: 'pkcs8' })
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();

// init's certificates (the client trusts their CA) and the "real" upstream's, from another CA.
export const PROXY_CERTS = MINTER.mint(HOSTS);
export const UPSTREAM_CERTS = MINTER.mint(HOSTS);

export interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
  readonly servername: unknown;
}

/** A local stand-in for the real host, recording what reaches it. */
export async function upstream(answer: http.RequestListener, certs = UPSTREAM_CERTS) {
  const seen: Seen[] = [];
  const server = https.createServer(
    { key: keyPem(certs), cert: certs.certPem },
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks),
          servername: (request.socket as tls.TLSSocket).servername,
        });
        answer(request, response);
      });
    },
  );
  let connections = 0;
  server.on('connection', () => (connections += 1));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  CLEANUP.push(() => new Promise((resolve) => server.close(resolve)));
  return {
    port: (server.address() as net.AddressInfo).port,
    seen,
    connections: () => connections,
  };
}

/** The default forwarder, sending every target to `port` on localhost and trusting UPSTREAM_CERTS. */
export const localForwarder = (port: number) =>
  forwarder({ upstreamCa: [UPSTREAM_CERTS.caPem], resolve: () => ({ host: '127.0.0.1', port }) });

/** The real proxy intercepting `hosts` with `handler` (the interceptor's default when undefined). */
export async function proxyWith(
  handler: RequestHandler | undefined,
  { hosts = HOSTS, certs = PROXY_CERTS }: { hosts?: string[]; certs?: Certificates } = {},
) {
  const intercept = createInterceptor({
    keyPem: keyPem(certs),
    certPem: certs.certPem,
    ...(handler === undefined ? {} : { handler }),
  });
  // Records the early bytes each CONNECT arrived with.
  const heads: number[] = [];
  const started = await startProxy({
    interceptHosts: hosts,
    intercept: (target, targetPort, client, head) => {
      heads.push(head.length);
      intercept(target, targetPort, client, head);
    },
  });
  CLEANUP.push(() => started.close());
  return { port: started.port, heads };
}

export const connectTo = (host: string, port: number) =>
  `CONNECT ${host}:${String(port)} HTTP/1.1\r\nHost: ${host}:${String(port)}\r\n\r\n`;

export async function handshake(secure: tls.TLSSocket) {
  await new Promise<void>((resolve, reject) => {
    secure.once('secureConnect', resolve);
    secure.once('error', reject);
  });
  CLEANUP.push(() => secure.destroy());
  return secure;
}

/** CONNECT through the proxy, then TLS to `host` trusting `ca`. */
export async function secureThrough(
  proxyPort: number,
  ca = PROXY_CERTS.caPem,
  alpn?: string[],
  { host = HOST, port = 443 } = {},
) {
  const raw = net.connect(proxyPort, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    raw.once('error', reject);
    raw.write(connectTo(host, port));
    raw.once('data', () => {
      resolve();
    });
  });
  return handshake(
    tls.connect({ socket: raw, servername: host, ca, ...(alpn ? { ALPNProtocols: alpn } : {}) }),
  );
}

/** One HTTP request over `secure`, resolving with the reply and its body. */
export function send(
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

// Synthetic protected values: a customer-id pattern and a fixed test key.
export const KEY = Uint8Array.from(Array(32).keys());
export const CUSTOMER = 'pattern:customer-id';
export const DETECTORS = buildDetectors([
  { kind: 'pattern', name: 'customer-id', prefix: 'CUST', pattern: 'CUST-\\d{4,}' },
]);
export const ID = 'CUST-0001';
export const PLACEHOLDER = new TokenMap(KEY).issue(CUSTOMER, 'CUST', ID, ID);

/** A model request mentioning `id` in five places: system, user text, reply, tool call, tool result. */
export const modelRequest = (id: string) => ({
  model: 'claude-haiku-5-5',
  max_tokens: 1024,
  stream: true,
  system: [{ type: 'text', text: `You help with ${id}.` }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: `Look up ${id}` }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `Reading ${id} now.` },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: `/data/${id}.csv` } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `${id},42` }],
    },
  ],
});

export interface Call {
  readonly host?: string;
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer | object | undefined;
}

const bytesOf = (body: Call['body']) =>
  body === undefined
    ? undefined
    : Buffer.isBuffer(body)
      ? body
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));

/** One request through the proxy, by default a model request to api.anthropic.com. */
export async function call(port: number, call: Call = {}) {
  const host = call.host ?? HOST;
  const secure = await secureThrough(port, undefined, undefined, { host });
  return send(
    secure,
    {
      method: call.method ?? 'POST',
      path: call.path ?? '/v1/messages?beta=true',
      headers: { host, ...call.headers },
    },
    bytesOf(call.body),
  );
}
