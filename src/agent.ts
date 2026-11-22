import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCertificates } from './cert-store.ts';
import { loadConfig } from './config.ts';
import type { SecretStore } from './keychain.ts';
import type { Run } from './process.ts';
import { portFree, queryStatus } from './serve.ts';

const LAUNCHCTL = '/bin/launchctl';
/** One agent per data folder: this, a dot, and 8 hex characters of the folder's SHA-256. */
export const LABEL_PREFIX = 'io.github.aarushgarg1110.amygdala';
const LABEL_HASH_CHARS = 8;
/** Where the agent's serve writes, in the data folder. */
export const LOG_FILE = 'proxy.log';
/** Long enough to type the password into the Keychain dialog. */
export const START_TIMEOUT_MS = 120_000;
const POLL_MS = 250;
const LOG_TAIL_LINES = 20;
// What `serve --agent` writes when it refuses to start; `start` stops waiting when it sees one.
const REFUSAL = /^amygdala serve: .*$/m;

/** `start` or `stop` can't go on; the message says why. */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

export interface AgentDeps {
  /** Runs launchctl; swappable so tests never touch the real launchd. */
  readonly run: Run;
  readonly uid: number;
  readonly home: string;
  /** The node and the entry point the agent runs: the ones that ran `start`. */
  readonly node: string;
  readonly entry: string;
  /** The main key's store, asked by name only: `start` never reads the key. */
  readonly store: SecretStore;
  readonly tlsKeys: SecretStore;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const agentLabel = (dir: string) =>
  `${LABEL_PREFIX}.${createHash('sha256').update(dir).digest('hex').slice(0, LABEL_HASH_CHARS)}`;

export const plistPath = (home: string, label: string) =>
  join(home, 'Library', 'LaunchAgents', `${label}.plist`);

const xml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The LaunchAgent: serve --agent at load and at login, restarted when it exits unsuccessfully. */
export function plistFor(label: string, dir: string, node: string, entry: string): string {
  const log = xml(join(dir, LOG_FILE));
  const args = [node, entry, 'serve', '--agent'].map((arg) => `    <string>${xml(arg)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AMYGDALA_DIR</key>
    <string>${xml(dir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

const logSize = (file: string) => statSync(file, { throwIfNoEntry: false })?.size ?? 0;

function logTail(file: string): string {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').trimEnd().split('\n') : [];
  return lines.slice(-LOG_TAIL_LINES).join('\n');
}

/** The checks `start` runs in the terminal, without reading the key; each failure says why. */
async function preflight(dir: string, deps: AgentDeps): Promise<void> {
  const config = loadConfig(dir);
  loadCertificates(dir, deps.tlsKeys);
  if (!deps.store.has(dir)) throw new AgentError(`no key for ${dir}: run \`amygdala init\``);
  const running = await queryStatus(dir);
  if (running !== undefined) {
    throw new AgentError(`already running for ${dir} (pid ${String(running.pid)})`);
  }
  await portFree(config.port);
}

/**
 * Turns the proxy for `dir` on, now and at every login: checks, writes the agent, loads it and
 * waits for it to answer. Anything short of a running proxy is undone.
 */
export async function start(dir: string, deps: AgentDeps): Promise<string[]> {
  await preflight(dir, deps);
  const label = agentLabel(dir);
  const plist = plistPath(deps.home, label);
  const domain = `gui/${String(deps.uid)}`;
  const log = join(dir, LOG_FILE);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? START_TIMEOUT_MS;
  // Anything short of a running proxy is taken back out: unloaded, uninstalled, reason shown.
  const undo = (reason: string): never => {
    deps.run(LAUNCHCTL, ['bootout', `${domain}/${label}`]);
    rmSync(plist, { force: true });
    throw new AgentError(`${reason}; last lines of ${log}:\n${logTail(log)}`);
  };

  mkdirSync(join(deps.home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(plist, plistFor(label, dir, deps.node, deps.entry), { mode: 0o644 });
  // An agent of this label may still be loaded, from a crash loop or an old node.
  if (deps.run(LAUNCHCTL, ['print', `${domain}/${label}`]).status === 0) {
    deps.run(LAUNCHCTL, ['bootout', `${domain}/${label}`]);
  }
  const offset = logSize(log);
  const loaded = deps.run(LAUNCHCTL, ['bootstrap', domain, plist]);
  if (loaded.status !== 0) {
    rmSync(plist, { force: true });
    throw new AgentError(
      `launchctl bootstrap failed (exit ${String(loaded.status)}): ${loaded.stderr.trim()}`,
    );
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await queryStatus(dir);
    if (status !== undefined) {
      return [`started (pid ${String(status.pid)}, port ${String(status.port)}), log ${log}`];
    }
    const fresh = existsSync(log) ? readFileSync(log, 'utf8').slice(offset) : '';
    const refused = REFUSAL.exec(fresh);
    if (refused !== null) return undo(refused[0]);
    await sleep(POLL_MS);
  }
  return undo(`the proxy did not answer within ${String(timeoutMs / 1000)} s`);
}

/** Turns the proxy for `dir` off, now and at login. */
export function stop(dir: string, deps: AgentDeps): string[] {
  const label = agentLabel(dir);
  const plist = plistPath(deps.home, label);
  const target = `gui/${String(deps.uid)}/${label}`;
  const loaded = deps.run(LAUNCHCTL, ['print', target]).status === 0;
  if (!loaded && !existsSync(plist)) return ['not running'];
  if (loaded) {
    const result = deps.run(LAUNCHCTL, ['bootout', target]);
    if (result.status !== 0) {
      throw new AgentError(
        `launchctl bootout failed (exit ${String(result.status)}): ${result.stderr.trim()}`,
      );
    }
  }
  rmSync(plist, { force: true });
  return ['stopped'];
}
