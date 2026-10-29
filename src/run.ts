import { readFileSync } from 'node:fs';

/** What a command prints and the code it exits with; the entry point does the writing. */
export interface Outcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const USAGE = `Usage: amygdala <command>

Keeps confidential strings out of what Claude Code sends to Anthropic. Pre-alpha: nothing works yet.

Options:
  --help     Show this help
  --version  Show the version
`;

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

export function run(args: readonly string[]): Outcome {
  const [command] = args;
  if (command === undefined || command === '--help') {
    return { exitCode: 0, stdout: USAGE, stderr: '' };
  }
  if (command === '--version') {
    return { exitCode: 0, stdout: `${packageVersion()}\n`, stderr: '' };
  }
  return {
    exitCode: EXIT_USAGE,
    stdout: '',
    stderr: `amygdala: unknown command "${command}". Run amygdala --help.\n`,
  };
}
