import { readFileSync } from 'node:fs';
import { dataDir, init, InitError } from './init.ts';
import { KeychainError, MacKeychain, type SecretStore } from './keychain.ts';

/** What a command prints and the code it exits with; the entry point does the writing. */
export interface Outcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What commands reach outside themselves through, so tests can hand in their own. */
export interface Deps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly store: SecretStore;
}

const USAGE = `Usage: amygdala <command>

Keeps confidential strings out of what Claude Code sends to Anthropic. Pre-alpha: nothing works yet.

Commands:
  init       Create the data folder, its key in the Keychain and a default config

Options:
  --help     Show this help
  --version  Show the version
`;

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

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

export function run(
  args: readonly string[],
  deps: Deps = { env: process.env, store: new MacKeychain() },
): Outcome {
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

function runInit(options: readonly string[], deps: Deps): Outcome {
  const [option] = options;
  if (option !== undefined) {
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr: `amygdala init: unknown option "${option}". Run amygdala --help.\n`,
    };
  }
  try {
    const lines = init(dataDir(deps.env), deps.store);
    return { exitCode: 0, stdout: lines.map((line) => `${line}\n`).join(''), stderr: '' };
  } catch (error) {
    // A file-system refusal (no permission) carries a code; anything else is a bug and crashes.
    const known =
      error instanceof InitError ||
      error instanceof KeychainError ||
      (error instanceof Error && 'code' in error);
    if (!known) throw error;
    return { exitCode: EXIT_FAILURE, stdout: '', stderr: `amygdala init: ${error.message}\n` };
  }
}
