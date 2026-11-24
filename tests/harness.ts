// Real local TLS on both sides of the proxy, for tests of what the intercept handlers send and return.
import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import type { Certificates } from '../src/certs.ts';
import { CONFIG_FILE } from '../src/config.ts';
import { init } from '../src/init.ts';
import type { MainDeps } from '../src/run.ts';
import { buildDetectors } from '../src/engine/detector.ts';
import { TokenMap } from '../src/engine/token-map.ts';
import { createInterceptor, forwarder, type RequestHandler } from '../src/intercept.ts';
import { startProxy } from '../src/proxy.ts';
import { CONTROL_SOCKET } from '../src/serve.ts';
import { MINTER } from './deps.ts';
import { MemoryStore } from './memory-store.ts';

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

// Real data folders for the serve, start and stop tests.
/** launchd for tests that must never reach it: any call fails the test. */
export const NO_LAUNCHD: MainDeps['launch'] = {
  run: (command, args) => {
    throw new Error(`launchctl must not run here: ${args.join(' ')}`);
  },
  uid: 501,
  home: '/nonexistent',
  node: process.execPath,
  entry: '/nonexistent/cli.js',
};

/** A config with the synthetic customer-id detector on `port`. */
export const CONFIG = (port: number) => `[[detectors]]
kind = "pattern"
name = "customer-id"
prefix = "CUST"
pattern = 'CUST-\\d{4,}'

[proxy]
port = ${String(port)}
`;

/** A port nothing listens on right now. */
export async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Whether anything accepts connections on `port` of localhost. */
export const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });

/** A data folder set up by init, its config holding the customer-id detector and a free port. */
export async function dataFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'amyg-'));
  CLEANUP.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new MemoryStore();
  const tlsKeys = new MemoryStore();
  init(dir, { store, tlsKeys, minter: MINTER });
  const port = await freePort();
  writeFileSync(join(dir, CONFIG_FILE), CONFIG(port));
  const up = await upstream((request, response) => response.end('ok'));
  const lines: string[] = [];
  const deps = {
    store,
    tlsKeys,
    version: 'test',
    log: (line: string) => lines.push(line),
    forward: localForwarder(up.port),
  };
  return { dir, port, store, up, lines, deps, socket: join(dir, CONTROL_SOCKET) };
}

export type Folder = Awaited<ReturnType<typeof dataFolder>>;

export const reads = (store: MemoryStore) =>
  store.calls.filter((call) => call.startsWith('read ')).length;

/** main's dependencies for `folder`, with signals handed to the test instead of the process. */
export function mainDeps(
  folder: Folder,
  onSignals: MainDeps['onSignals'] = () => undefined,
  { local = true, launch = NO_LAUNCHD }: { local?: boolean; launch?: MainDeps['launch'] } = {},
): MainDeps {
  return {
    env: { AMYGDALA_DIR: folder.dir },
    store: folder.store,
    tlsKeys: folder.deps.tlsKeys,
    minter: MINTER,
    log: folder.deps.log,
    // Without it serve would forward to the real hosts; only refused starts leave it out.
    ...(local ? { forward: folder.deps.forward } : {}),
    onSignals,
    launch,
  };
}
