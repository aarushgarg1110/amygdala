import { chmodSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { loadCertificates } from './cert-store.ts';
import { loadConfig } from './config.ts';
import { OWN_KEY_DETECTOR } from './engine/detectors/own-key.ts';
import { isRecord } from './engine/stream.ts';
import { createInterceptor, forwarder, type Forward } from './intercept.ts';
import { loadKey } from './key.ts';
import type { SecretStore } from './keychain.ts';
import { LISTEN_HOST, startProxy, type Proxy } from './proxy.ts';
import { createScrubber, type Decision } from './scrub.ts';

/** The control socket in the data folder: `status` now, `watch` later (plan 5.5). */
export const CONTROL_SOCKET = 'control.sock';
// Owner only: the socket will carry what `watch` shows, which is the user's whole conversation.
const SOCKET_MODE = 0o600;
const STATUS_REQUEST = 'status\n';
// What the socket answers before the proxy is up (the key may still be waiting for a password).
const NOT_YET = '{"running":false}';

/** `serve` can't start; the message says why and what to do. */
export class ServeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServeError';
  }
}

/** What a running `serve` reports over its control socket. */
export interface Status {
  readonly running: true;
  readonly version: string;
  readonly pid: number;
  readonly port: number;
  readonly startedAt: string;
  readonly detectors: readonly string[];
  readonly requests: Readonly<Record<Decision['action'], number>>;
  readonly hits: Readonly<Record<string, number>>;
}

const isStatus = (value: unknown): value is Status =>
  isRecord(value) &&
  value.running === true &&
  typeof value.pid === 'number' &&
  typeof value.port === 'number';

export interface ServeDeps {
  /** The main key's store: reading it shows the password dialog (Q15). */
  readonly store: SecretStore;
  readonly tlsKeys: SecretStore;
  readonly version: string;
  /** Receives one line per request, and the start; never a value. */
  readonly log: (line: string) => void;
  /** Where requests go once scrubbed: the real hosts unless a test points them elsewhere. */
  readonly forward?: Forward;
  readonly now?: () => Date;
}

export interface Running {
  readonly port: number;
  readonly socket: string;
  /** Stops the proxy and removes the control socket. */
  close(): Promise<void>;
}

/** The running `serve` for `dir`, or undefined; a socket left by a crash is removed. */
export async function queryStatus(dir: string): Promise<Status | undefined> {
  const socket = join(dir, CONTROL_SOCKET);
  const reply = await new Promise<string | undefined>((resolve, reject) => {
    const client = net.connect(socket);
    let text = '';
    client.on('connect', () => client.end(STATUS_REQUEST));
    client.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    client.on('end', () => {
      resolve(text);
    });
    client.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') resolve(undefined);
      else if (error.code === 'ECONNREFUSED') {
        // The file is there but nothing listens: the last `serve` died without cleaning up.
        rmSync(socket, { force: true });
        resolve(undefined);
      } else reject(error);
    });
  });
  if (reply === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    // Something else answers on the path: it isn't a serve, whatever it is.
    return undefined;
  }
  return isStatus(parsed) ? parsed : undefined;
}

const listen = (server: net.Server, at: net.ListenOptions) =>
  new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(at, () => {
      server.off('error', reject);
      resolve();
    });
  });

const closed = (server: net.Server) =>
  new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

/** Closes the control socket, ending any client still attached, so a stop never waits on one. */
async function release(control: net.Server, clients: Set<net.Socket>, socket: string) {
  for (const client of clients) client.destroy();
  await closed(control);
  rmSync(socket, { force: true });
}

/**
 * Takes the control socket, which doubles as the data folder's lock: a live `serve` there means
 * already running; a socket left by a crash is removed and taken.
 */
async function claim(control: net.Server, socket: string, dir: string): Promise<void> {
  try {
    await listen(control, { path: socket });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    const other = await queryStatus(dir);
    if (other !== undefined) {
      throw new ServeError(
        `already running for ${dir} (pid ${String(other.pid)}): amygdala status`,
      );
    }
    // queryStatus removed a stale socket; anything still holding the path makes this throw.
    await listen(control, { path: socket });
  }
  chmodSync(socket, SOCKET_MODE);
}

/** Resolves when `port` on the listen address can be bound, so the key is read only if it is. */
async function portFree(port: number): Promise<void> {
  const probe = net.createServer();
  try {
    await listen(probe, { port, host: LISTEN_HOST });
  } catch (error) {
    throw new ServeError(
      `cannot listen on port ${String(port)} (${(error as Error).message}): stop what holds it or set [proxy] port`,
    );
  }
  await closed(probe);
}

/** One line per request: what happened, never what it held (paths carry placeholders). */
export function logLine(decision: Decision, at: Date): string {
  const hits = Object.entries(decision.hits)
    .map(([name, count]) => ` ${name}=${String(count)}`)
    .join('');
  const thread = decision.thread ? ' thread' : '';
  const reason = decision.reason === undefined ? '' : ` (${decision.reason})`;
  return `${at.toISOString()} ${decision.action} ${decision.host} ${decision.method} ${decision.path}${hits}${thread}${reason}`;
}

/**
 * The proxy for the data folder `dir`, in this process. The control socket is taken first, as
 * the folder's lock; then the port is checked; the key comes last, so the password dialog appears
 * only when the start can succeed. The key is read once.
 */
export async function serve(dir: string, deps: ServeDeps): Promise<Running> {
  const now = deps.now ?? (() => new Date());
  const config = loadConfig(dir);
  const certs = loadCertificates(dir, deps.tlsKeys);
  const requests = { forwarded: 0, tokenized: 0, blocked: 0 };
  const hits: Record<string, number> = {};
  // Filled in once the proxy is up; until then the socket answers NOT_YET.
  const live: { status?: () => Status } = {};
  const clients = new Set<net.Socket>();
  // Defensive, untested: a query racing a start gets NOT_YET, and a client error never crashes.
  const control = net.createServer((client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('data', () =>
      client.end(live.status === undefined ? NOT_YET : JSON.stringify(live.status())),
    );
    client.on('error', () => client.destroy());
  });
  const socket = join(dir, CONTROL_SOCKET);
  await claim(control, socket, dir);

  let proxy: Proxy;
  try {
    await portFree(config.port);
    const key = loadKey(dir, deps.store);
    const handler = createScrubber({
      key,
      detectors: config.detectors,
      trust: config.trust,
      forward: deps.forward ?? forwarder(),
      report: (decision) => {
        requests[decision.action] += 1;
        for (const [name, count] of Object.entries(decision.hits)) {
          hits[name] = (hits[name] ?? 0) + count;
        }
        deps.log(logLine(decision, now()));
      },
    });
    proxy = await startProxy({
      port: config.port,
      interceptHosts: config.interceptHosts,
      intercept: createInterceptor({ keyPem: certs.keyPem, certPem: certs.certPem, handler }),
    });
  } catch (error) {
    // Nothing may stay listening after a refused start, the lock included.
    await release(control, clients, socket);
    throw error;
  }

  const startedAt = now().toISOString();
  const detectors = [...config.detectors.map((detector) => detector.name), OWN_KEY_DETECTOR];
  const { port } = proxy;
  live.status = () => ({
    running: true,
    version: deps.version,
    pid: process.pid,
    port,
    startedAt,
    detectors,
    requests,
    hits,
  });
  deps.log(
    `${startedAt} listening on ${LISTEN_HOST}:${String(port)} for ${dir} (pid ${String(process.pid)})`,
  );
  return {
    port,
    socket,
    close: async () => {
      await proxy.close();
      await release(control, clients, socket);
    },
  };
}
