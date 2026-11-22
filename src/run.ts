import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { AgentError, start, stop, type AgentDeps } from './agent.ts';
import { CertificateError } from './cert-store.ts';
import { MintError, OpensslMinter } from './certs.ts';
import { ConfigError } from './config.ts';
import { dataDir, init, InitError, type InitDeps } from './init.ts';
import type { Forward } from './intercept.ts';
import { KeyError } from './key.ts';
import { KeychainError, MacKeychain, tlsKeyStore } from './keychain.ts';
import { runProcess } from './process.ts';
import { queryStatus, serve, ServeError, type Running, type Status } from './serve.ts';

/** What a command prints and the code it exits with; the entry point does the writing. */
export interface Outcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What commands reach outside themselves through, so tests can hand in their own. */
export interface Deps extends InitDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
}

const realDeps = (): Deps => ({
  env: process.env,
  store: new MacKeychain(),
  tlsKeys: tlsKeyStore(),
  minter: new OpensslMinter(),
});

/** What the long-running commands reach outside themselves through, as well. */
export interface MainDeps extends Deps {
  /** `serve`'s lines as they happen (stderr), not collected into the outcome. */
  readonly log: (line: string) => void;
  /** Calls `stop` on the first of `signals`. */
  readonly onSignals: (signals: readonly NodeJS.Signals[], stop: () => void) => void;
  readonly forward?: Forward;
  /** What start and stop drive launchd with, and what the agent runs. */
  readonly launch: Omit<AgentDeps, 'store' | 'tlsKeys'>;
}

/** serve's lines go to stderr as they happen. */
export const stderrLine: MainDeps['log'] = (line) => {
  process.stderr.write(`${line}\n`);
};

/** The process's own signals; each handler runs once. */
export const processSignals: MainDeps['onSignals'] = (signals, stop) => {
  for (const signal of signals) process.once(signal, stop);
};

const realMainDeps = (): MainDeps => ({
  ...realDeps(),
  log: stderrLine,
  onSignals: processSignals,
  launch: {
    run: runProcess,
    uid: userInfo().uid,
    home: homedir(),
    // The agent runs the same node and entry point that ran start.
    node: process.execPath,
    entry: resolve(String(process.argv[1])),
  },
});

const REFUSALS = [
  InitError,
  KeychainError,
  ConfigError,
  MintError,
  CertificateError,
  KeyError,
  ServeError,
  AgentError,
];

/**
 * The message of an error a command reports as a refusal (a missing key, a taken port, a
 * file-system refusal with a code), or undefined for anything else: a bug, which must crash.
 */
export function refusalOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return REFUSALS.some((kind) => error instanceof kind) || 'code' in error
    ? error.message
    : undefined;
}

const USAGE = `Usage: amygdala <command>

Keeps confidential strings out of what Claude Code sends to Anthropic. Pre-alpha: nothing works yet.

Commands:
  init       Create the data folder, its key in the Keychain and a default config
  start      Turn the proxy on now and at every login (a macOS LaunchAgent)
  stop       Turn it off now and at login
  status     Say whether the proxy is running, and what it has seen
  serve      Run the proxy in this terminal until Ctrl-C (start runs this for you)

Options:
  --help     Show this help
  --version  Show the version
`;

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
/** `status` with nothing running, so a script can tell it from a failure. */
export const EXIT_NOT_RUNNING = 3;

type ReadFile = (url: URL) => string;

/** The version in package.json, which sits one level above both src/ and dist/. */
export function packageVersion(read: ReadFile = (url) => readFileSync(url, 'utf8')): string {
  const manifest: unknown = JSON.parse(read(new URL('../package.json', import.meta.url)));
  if (
    typeof manifest === 'object' &&
    manifest !== null &&
    'version' in manifest &&
    typeof manifest.version === 'string'
  ) {
    return manifest.version;
  }
  throw new Error('package.json has no string "version" field');
}

export function run(args: readonly string[], deps: Deps = realDeps()): Outcome {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help') {
    return { exitCode: 0, stdout: USAGE, stderr: '' };
  }
  if (command === '--version') {
    return { exitCode: 0, stdout: `${packageVersion()}\n`, stderr: '' };
  }
  if (command === 'init') return runInit(rest, deps);
  return {
    exitCode: EXIT_USAGE,
    stdout: '',
    stderr: `amygdala: unknown command "${command}". Run amygdala --help.\n`,
  };
}

const unknownOption = (command: string, option: string): Outcome => ({
  exitCode: EXIT_USAGE,
  stdout: '',
  stderr: `amygdala ${command}: unknown option "${option}". Run amygdala --help.\n`,
});

/** Every command, the long-running ones included; `run` keeps the ones that return at once. */
export async function main(
  args: readonly string[],
  deps: MainDeps = realMainDeps(),
): Promise<Outcome> {
  const [command, ...rest] = args;
  if (command === 'serve') return runServe(rest, deps);
  if (command === 'status') return runStatus(rest, deps);
  if (command === 'start') return runStart(rest, deps);
  if (command === 'stop') return runStop(rest, deps);
  return run(args, deps);
}

async function runServe(options: readonly string[], deps: MainDeps): Promise<Outcome> {
  // --agent: run by launchd, where a refusal must exit 0 or KeepAlive restarts it in a loop.
  const [option, extra] = options;
  const agent = option === '--agent';
  if (option !== undefined && !agent) return unknownOption('serve', option);
  if (extra !== undefined) return unknownOption('serve', extra);
  let running: Running;
  try {
    running = await serve(dataDir(deps.env), {
      store: deps.store,
      tlsKeys: deps.tlsKeys,
      version: packageVersion(),
      log: deps.log,
      ...(deps.forward === undefined ? {} : { forward: deps.forward }),
    });
  } catch (error) {
    const reason = refusalOf(error);
    if (reason === undefined) throw error;
    return {
      exitCode: agent ? 0 : EXIT_FAILURE,
      stdout: '',
      stderr: `amygdala serve: ${reason}\n`,
    };
  }
  await new Promise<void>((resolve) => {
    deps.onSignals(['SIGTERM', 'SIGINT'], resolve);
  });
  await running.close();
  return { exitCode: 0, stdout: '', stderr: '' };
}

/** What `status` prints for a running proxy. */
export function formatStatus(status: Status): string {
  const { requests } = status;
  const hits = Object.entries(status.hits).map(([name, count]) => `${name} ${String(count)}`);
  return [
    `running   pid ${String(status.pid)}, port ${String(status.port)}, since ${status.startedAt}, version ${status.version}`,
    `detectors ${status.detectors.join(', ')}`,
    `requests  ${String(requests.tokenized)} tokenized, ${String(requests.forwarded)} forwarded, ${String(requests.blocked)} blocked`,
    `hits      ${hits.length === 0 ? 'none' : hits.join(', ')}`,
    '',
  ].join('\n');
}

async function runStatus(options: readonly string[], deps: MainDeps): Promise<Outcome> {
  const [option] = options;
  if (option !== undefined) return unknownOption('status', option);
  let status: Status | undefined;
  try {
    status = await queryStatus(dataDir(deps.env));
  } catch (error) {
    // Read-only, so any failure is reported rather than thrown: e.g. a file that isn't a socket.
    return {
      exitCode: EXIT_FAILURE,
      stdout: '',
      stderr: `amygdala status: ${(error as Error).message}\n`,
    };
  }
  if (status === undefined) {
    return {
      exitCode: EXIT_NOT_RUNNING,
      stdout: '',
      stderr: 'amygdala: not running: amygdala start\n',
    };
  }
  return { exitCode: 0, stdout: formatStatus(status), stderr: '' };
}

const agentDeps = (deps: MainDeps): AgentDeps => ({
  ...deps.launch,
  store: deps.store,
  tlsKeys: deps.tlsKeys,
});

async function runStart(options: readonly string[], deps: MainDeps): Promise<Outcome> {
  const [option] = options;
  if (option !== undefined) return unknownOption('start', option);
  try {
    const lines = await start(dataDir(deps.env), agentDeps(deps));
    return { exitCode: 0, stdout: lines.map((line) => `${line}\n`).join(''), stderr: '' };
  } catch (error) {
    const reason = refusalOf(error);
    if (reason === undefined) throw error;
    return { exitCode: EXIT_FAILURE, stdout: '', stderr: `amygdala start: ${reason}\n` };
  }
}

function runStop(options: readonly string[], deps: MainDeps): Outcome {
  const [option] = options;
  if (option !== undefined) return unknownOption('stop', option);
  try {
    const lines = stop(dataDir(deps.env), agentDeps(deps));
    return { exitCode: 0, stdout: lines.map((line) => `${line}\n`).join(''), stderr: '' };
  } catch (error) {
    const reason = refusalOf(error);
    if (reason === undefined) throw error;
    return { exitCode: EXIT_FAILURE, stdout: '', stderr: `amygdala stop: ${reason}\n` };
  }
}

function runInit(options: readonly string[], deps: Deps): Outcome {
  const [option] = options;
  if (option !== undefined) return unknownOption('init', option);
  try {
    const lines = init(dataDir(deps.env), deps);
    return { exitCode: 0, stdout: lines.map((line) => `${line}\n`).join(''), stderr: '' };
  } catch (error) {
    const reason = refusalOf(error);
    if (reason === undefined) throw error;
    return { exitCode: EXIT_FAILURE, stdout: '', stderr: `amygdala init: ${reason}\n` };
  }
}
