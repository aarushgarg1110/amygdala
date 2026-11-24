import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CA_FILE } from '../src/cert-store.ts';
import { CONFIG_FILE } from '../src/config.ts';
import { main } from '../src/run.ts';
import { CLAUDE_SETTINGS, shellFunction } from '../src/shell.ts';
import { CLEANUP, cleanup, dataFolder, mainDeps } from './harness.ts';

afterEach(cleanup);

const SHELL_ARGS: Record<string, readonly string[]> = {
  zsh: ['-f', '-c'],
  bash: ['--noprofile', '--norc', '-c'],
};
// What the fake claude reports from its environment.
const WATCHED = [
  'HTTPS_PROXY',
  'https_proxy',
  'NODE_EXTRA_CA_CERTS',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
  'DISABLE_FEEDBACK_COMMAND',
  'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY',
  'DISABLE_ERROR_REPORTING',
  'NO_PROXY',
  'no_proxy',
  'CLAUDE_CODE_USE_BEDROCK',
  'ANTHROPIC_BASE_URL',
];

/** A folder for the function: a fake claude on PATH, and a fake status whose exit code a file sets. */
function workspace(folderName = 'data') {
  const root = mkdtempSync(join(tmpdir(), 'amyg-shell-'));
  CLEANUP.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const dir = join(root, folderName);
  const bin = join(root, 'bin');
  mkdirSync(dir);
  mkdirSync(bin);
  const claude = join(bin, 'claude');
  writeFileSync(
    claude,
    `#!/usr/bin/env node
const env = Object.fromEntries(${JSON.stringify(WATCHED)}.map((name) => [name, process.env[name] ?? null]));
console.log(JSON.stringify({ args: process.argv.slice(2), env }));
`,
  );
  chmodSync(claude, 0o755);
  const status = join(root, 'status.mjs');
  writeFileSync(
    status,
    `import { readFileSync } from 'node:fs';
let code = 0;
try { code = Number(readFileSync(process.env.AMYGDALA_DIR + '/status-code', 'utf8')); } catch {}
process.exit(process.argv[2] === 'status' ? code : 9);
`,
  );
  const fn = shellFunction({ dir, port: 47_070, node: process.execPath, entry: status });
  const run = (
    shell: string,
    script: string,
    args: readonly string[] = [],
    env: Record<string, string> = {},
  ) => {
    const result = spawnSync(
      shell,
      [...(SHELL_ARGS[shell] ?? []), `${fn}\n${script}`, shell, ...args],
      {
        encoding: 'utf8',
        env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, ...env },
      },
    );
    const seen =
      result.stdout === ''
        ? undefined
        : (JSON.parse(result.stdout) as { args: string[]; env: Record<string, string | null> });
    return { status: result.status, stderr: result.stderr, seen };
  };
  return {
    dir,
    fn,
    run,
    notRunning: () => {
      writeFileSync(join(dir, 'status-code'), '3');
    },
  };
}

const SETTINGS = JSON.stringify(CLAUDE_SETTINGS);

test('should turn Remote Control and claude.ai connectors off by the keys measured on 11-22', () => {
  expect(CLAUDE_SETTINGS).toEqual({
    remoteControlAtStartup: false,
    disableRemoteControl: true,
    disableClaudeAiConnectors: true,
  });
});

describe.each(['zsh', 'bash'])('the claude shell function in %s', (shell) => {
  test('should run claude through the proxy with every argument intact', () => {
    const { dir, run } = workspace();
    const { status, seen } = run(shell, 'claude "$@"', ['a', 'b c', '']);
    expect(status).toBe(0);
    expect(seen?.args).toEqual(['--settings', SETTINGS, 'a', 'b c', '']);
    expect(seen?.env).toMatchObject({
      HTTPS_PROXY: 'http://127.0.0.1:47070',
      https_proxy: 'http://127.0.0.1:47070',
      NODE_EXTRA_CA_CERTS: join(dir, CA_FILE),
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      DISABLE_FEEDBACK_COMMAND: '1',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
      DISABLE_ERROR_REPORTING: '1',
    });
  });

  test('should refuse when the proxy is not running, never running claude', () => {
    const { run, notRunning } = workspace();
    notRunning();
    const { status, stderr, seen } = run(shell, 'claude x');
    expect([status, seen]).toEqual([1, undefined]);
    expect(stderr).toMatch(/^amygdala is not running, so claude would not be protected/);
  });

  test.each([
    ['NO_PROXY', 'api.anthropic.com', true],
    ['no_proxy', '*', true],
    ['CLAUDE_CODE_USE_BEDROCK', '0', true],
    ['CLAUDE_CODE_USE_BEDROCK', 'false', true],
    ['CLAUDE_CODE_USE_BEDROCK', '1', false],
    ['CLAUDE_CODE_USE_VERTEX', 'true', false],
    ['ANTHROPIC_BASE_URL', 'https://example.test', false],
  ])('should strip NO_PROXY and refuse a route around amygdala: %s=%s', (name, value, runs) => {
    const { run } = workspace();
    const { status, stderr, seen } = run(
      shell,
      'export ' + name + '=' + `'${value}'` + '\nclaude x',
    );
    if (runs) {
      expect([status, seen?.env[name]]).toEqual([0, null]);
    } else {
      expect([status, seen]).toEqual([1, undefined]);
      expect(stderr).toBe(
        `${name} is on, which would send claude around amygdala: use command claude for that session\n`,
      );
    }
  });

  test('should leave command claude unprotected', () => {
    const { run } = workspace();
    const { seen } = run(shell, 'command claude x');
    expect([seen?.args, seen?.env.HTTPS_PROXY]).toEqual([['x'], null]);
  });

  test('should quote a data folder with spaces and a quote', () => {
    const { dir, run, notRunning } = workspace("my data's folder");
    const ran = run(shell, 'claude x');
    notRunning();
    const refused = run(shell, 'claude x');
    expect([ran.status, ran.seen?.env.NODE_EXTRA_CA_CERTS]).toEqual([0, join(dir, CA_FILE)]);
    expect(refused.status).toBe(1);
  });
});

describe('amygdala shell-init', () => {
  test('should print a function with the data folder baked in', async () => {
    const folder = await dataFolder();
    const outcome = await main(['shell-init', 'zsh'], mainDeps(folder));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toMatch(/^claude\(\) \{\n/);
    for (const part of [
      `AMYGDALA_DIR='${folder.dir}'`,
      `HTTPS_PROXY='http://127.0.0.1:${String(folder.port)}'`,
      `NODE_EXTRA_CA_CERTS='${join(folder.dir, CA_FILE)}'`,
      `'${process.execPath}' '/nonexistent/cli.js' status`,
      `--settings '${SETTINGS}' "$@"`,
    ]) {
      expect(outcome.stdout).toContain(part);
    }
  });

  test.each([
    [[], 2, /^amygdala shell-init: name a shell, zsh or bash/],
    [['fish'], 2, /^amygdala shell-init: name a shell/],
    [['zsh', '--now'], 2, /unknown option "--now"/],
  ])(
    'should refuse an unknown shell or a folder without a config: %j',
    async (args, code, message) => {
      const folder = await dataFolder();
      const outcome = await main(['shell-init', ...args], mainDeps(folder));
      expect([outcome.exitCode, outcome.stderr]).toEqual([
        code,
        expect.stringMatching(message) as unknown,
      ]);
    },
  );

  test('should report a data folder without a config', async () => {
    const folder = await dataFolder();
    rmSync(join(folder.dir, CONFIG_FILE));
    const outcome = await main(['shell-init', 'zsh'], mainDeps(folder));
    expect([outcome.exitCode, outcome.stderr]).toEqual([
      1,
      expect.stringMatching(/^amygdala shell-init: .*no config here/) as unknown,
    ]);
  });
});
