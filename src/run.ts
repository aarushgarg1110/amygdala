import { readFileSync } from 'node:fs';
import { CertificateError } from './cert-store.ts';
import { MintError, OpensslMinter } from './certs.ts';
import { ConfigError } from './config.ts';
import { dataDir, init, InitError, type InitDeps } from './init.ts';
import type { Forward } from './intercept.ts';
import { KeyError } from './key.ts';
import { KeychainError, MacKeychain, tlsKeyStore } from './keychain.ts';
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
});

const USAGE = `Usage: amygdala <command>

Keeps confidential strings out of what Claude Code sends to Anthropic. Pre-alpha: nothing works yet.

Commands:
  init       Create the data folder, its key in the Keychain and a default config
  serve      Run the proxy in this terminal until Ctrl-C
  status     Say whether the proxy is running, and what it has seen

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
  return run(args, deps);
}

async function runServe(options: readonly string[], deps: MainDeps): Promise<Outcome> {
  const [option] = options;
  if (option !== undefined) return unknownOption('serve', option);
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
    // A refusal names its cause; anything else is a bug and crashes.
    const known =
      error instanceof ServeError ||
      error instanceof ConfigError ||
      error instanceof CertificateError ||
      error instanceof KeyError ||
      error instanceof KeychainError ||
      (error instanceof Error && 'code' in error);
    if (!known) throw error;
    return { exitCode: EXIT_FAILURE, stdout: '', stderr: `amygdala serve: ${error.message}\n` };
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

function runInit(options: readonly string[], deps: Deps): Outcome {
  const [option] = options;
  if (option !== undefined) return unknownOption('init', option);
  try {
    const lines = init(dataDir(deps.env), deps);
    return { exitCode: 0, stdout: lines.map((line) => `${line}\n`).join(''), stderr: '' };
  } catch (error) {
    // A file-system refusal (no permission) carries a code; anything else is a bug and crashes.
    const known =
      error instanceof InitError ||
      error instanceof KeychainError ||
      error instanceof ConfigError ||
      error instanceof MintError ||
      error instanceof CertificateError ||
      (error instanceof Error && 'code' in error);
    if (!known) throw error;
    return { exitCode: EXIT_FAILURE, stdout: '', stderr: `amygdala init: ${error.message}\n` };
  }
}
