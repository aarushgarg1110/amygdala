import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AgentError,
  agentLabel,
  LOG_FILE,
  plistPath,
  start,
  stop,
  type AgentDeps,
} from '../src/agent.ts';
import { CA_FILE, CertificateError } from '../src/cert-store.ts';
import { MintError } from '../src/certs.ts';
import { CONFIG_FILE, ConfigError } from '../src/config.ts';
import { InitError } from '../src/init.ts';
import { KeyError } from '../src/key.ts';
import { KeychainError } from '../src/keychain.ts';
import type { Run } from '../src/process.ts';
import { main, refusalOf } from '../src/run.ts';
import { queryStatus, serve, ServeError, type Running } from '../src/serve.ts';
import { CLEANUP, cleanup, dataFolder, type Folder, mainDeps, reads } from './harness.ts';
import { MemoryStore } from './memory-store.ts';

afterEach(cleanup);

const UID = 501;
const ENTRY = '/opt/amygdala/dist/cli.js';
const OK = { status: 0, stdout: '', stderr: '' };

type Behavior =
  'serve' | 'silent' | 'refuse' | { readonly bootstrap?: number; readonly bootout?: number };

/** A launchd stand-in: it records each launchctl call, and bootstrap starts serve in this process. */
function fakeLaunchd(folder: Folder, behavior: Behavior = 'serve', { loaded = false } = {}) {
  const calls: string[] = [];
  const state: {
    loaded: boolean;
    running: Promise<Running> | undefined;
    closing: Promise<unknown> | undefined;
  } = { loaded, running: undefined, closing: undefined };
  const halt = () => {
    const running = state.running;
    state.running = undefined;
    state.closing = running?.then(
      (proxy) => proxy.close(),
      () => undefined,
    );
    return state.closing;
  };
  CLEANUP.push(halt);
  const run: Run = (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    const [verb] = args;
    if (verb === 'print')
      return state.loaded ? OK : { status: 113, stdout: '', stderr: 'Could not find service' };
    if (verb === 'bootout') {
      if (typeof behavior === 'object' && behavior.bootout !== undefined) {
        return {
          status: behavior.bootout,
          stdout: '',
          stderr: 'Boot-out failed: 3: No such process',
        };
      }
      state.loaded = false;
      void halt();
      return OK;
    }
    if (typeof behavior === 'object' && behavior.bootstrap !== undefined) {
      return {
        status: behavior.bootstrap,
        stdout: '',
        stderr: 'Bootstrap failed: 5: Input/output error',
      };
    }
    state.loaded = true;
    if (behavior === 'serve') state.running = serve(folder.dir, folder.deps);
    if (behavior === 'refuse') {
      appendFileSync(
        join(folder.dir, LOG_FILE),
        'amygdala serve: no key for the folder: run `amygdala init`\n',
      );
    }
    return OK;
  };
  return { run, calls, state };
}

type Launchd = ReturnType<typeof fakeLaunchd>;

const homeOf = (folder: Folder) => join(folder.dir, 'home');

function agentDeps(folder: Folder, launchd: Launchd, extra: Partial<AgentDeps> = {}): AgentDeps {
  return {
    run: launchd.run,
    uid: UID,
    home: homeOf(folder),
    node: process.execPath,
    entry: ENTRY,
    store: folder.store,
    tlsKeys: folder.deps.tlsKeys,
    ...extra,
  };
}

const fast = {
  timeoutMs: 400,
  sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
};

/** The plist as plutil reads it, which also proves it is a valid property list. */
const plistOf = (file: string): unknown =>
  JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }),
  );

describe('start and stop', () => {
  test('should install and load an agent that runs serve, then report it started', async () => {
    // Assemble
    const folder = await dataFolder();
    const launchd = fakeLaunchd(folder);
    const label = agentLabel(folder.dir);
    const plist = plistPath(homeOf(folder), label);

    // Act
    const lines = await start(folder.dir, agentDeps(folder, launchd));

    // Assert
    const log = join(folder.dir, LOG_FILE);
    expect(lines).toEqual([
      `started (pid ${String(process.pid)}, port ${String(folder.port)}), log ${log}`,
    ]);
    expect(launchd.calls).toEqual([
      `/bin/launchctl print gui/${String(UID)}/${label}`,
      `/bin/launchctl bootstrap gui/${String(UID)} ${plist}`,
    ]);
    expect(plistOf(plist)).toEqual({
      Label: label,
      ProgramArguments: [process.execPath, ENTRY, 'serve', '--agent'],
      EnvironmentVariables: { AMYGDALA_DIR: folder.dir },
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      StandardOutPath: log,
      StandardErrorPath: log,
    });
    expect(label).toMatch(/^io\.github\.aarushgarg1110\.amygdala\.[0-9a-f]{8}$/);
  });

  test('should give each data folder its own agent', async () => {
    const [one, two] = [await dataFolder(), await dataFolder()];
    await start(one.dir, agentDeps(one, fakeLaunchd(one)));
    await start(two.dir, agentDeps(two, fakeLaunchd(two)));
    expect(agentLabel(one.dir)).not.toBe(agentLabel(two.dir));
    expect([
      existsSync(plistPath(homeOf(one), agentLabel(one.dir))),
      existsSync(plistPath(homeOf(two), agentLabel(two.dir))),
    ]).toEqual([true, true]);
  });

  test.each([
    ['no config', (f: Folder) => (rmSync(join(f.dir, CONFIG_FILE)), {}), /no config here/],
    [
      'no certificates',
      (f: Folder) => (rmSync(join(f.dir, CA_FILE)), {}),
      /no usable certificates/,
    ],
    ['no key', () => ({ store: new MemoryStore() }), /no key for .*amygdala init/],
  ])(
    'should refuse a broken setup without installing anything or reading the key: %s',
    async (label, breakIt, message) => {
      const folder = await dataFolder();
      const launchd = fakeLaunchd(folder);
      const deps = agentDeps(folder, launchd, breakIt(folder));
      await expect(start(folder.dir, deps)).rejects.toThrow(message);
      expect([
        launchd.calls,
        existsSync(plistPath(homeOf(folder), agentLabel(folder.dir))),
      ]).toEqual([[], false]);
      expect(reads(folder.store)).toBe(0);
    },
  );

  test('should refuse a taken port, or a proxy already running, without installing anything', async () => {
    // Assemble: one folder whose port is taken, one whose proxy already runs
    const taken = await dataFolder();
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(taken.port, '127.0.0.1', resolve));
    CLEANUP.push(() => new Promise((resolve) => holder.close(resolve)));
    const busy = await dataFolder();
    const running = await serve(busy.dir, busy.deps);
    CLEANUP.push(() => running.close());
    const [one, two] = [fakeLaunchd(taken), fakeLaunchd(busy)];

    // Act and Assert
    await expect(start(taken.dir, agentDeps(taken, one))).rejects.toThrow(ServeError);
    await expect(start(busy.dir, agentDeps(busy, two))).rejects.toThrow(
      new RegExp(`already running for .* \\(pid ${String(process.pid)}\\)`),
    );
    expect([one.calls, two.calls, reads(taken.store), reads(busy.store)]).toEqual([[], [], 0, 1]);
  });

  test.each([
    [
      'it never answers',
      'silent' as const,
      /the proxy did not answer within 0\.4 s; last lines of .*proxy\.log:\n$/,
    ],
    [
      'serve refuses',
      'refuse' as const,
      /^amygdala serve: no key for the folder.*; last lines of .*proxy\.log:\namygdala serve: no key/s,
    ],
  ])(
    'should undo the install when the proxy never answers: %s',
    async (label, behavior, message) => {
      const folder = await dataFolder();
      const launchd = fakeLaunchd(folder, behavior);
      // The silent case keeps the real sleep between polls; only the timeout is shortened.
      const timing = behavior === 'silent' ? { timeoutMs: fast.timeoutMs } : fast;
      await expect(start(folder.dir, agentDeps(folder, launchd, timing))).rejects.toThrow(message);
      expect(launchd.calls.at(-1)).toBe(
        `/bin/launchctl bootout gui/${String(UID)}/${agentLabel(folder.dir)}`,
      );
      expect(existsSync(plistPath(homeOf(folder), agentLabel(folder.dir)))).toBe(false);
    },
  );

  test('should boot out a loaded agent of the same label before loading', async () => {
    const folder = await dataFolder();
    const launchd = fakeLaunchd(folder, 'serve', { loaded: true });
    await start(folder.dir, agentDeps(folder, launchd, fast));
    expect(launchd.calls.map((call) => call.split(' ')[1])).toEqual([
      'print',
      'bootout',
      'bootstrap',
    ]);
  });

  test('should report a failed bootstrap and remove the plist', async () => {
    const folder = await dataFolder();
    const launchd = fakeLaunchd(folder, { bootstrap: 5 });
    await expect(start(folder.dir, agentDeps(folder, launchd))).rejects.toThrow(
      'launchctl bootstrap failed (exit 5): Bootstrap failed: 5: Input/output error',
    );
    expect(existsSync(plistPath(homeOf(folder), agentLabel(folder.dir)))).toBe(false);
  });

  test('should stop and uninstall, and say when nothing is installed', async () => {
    // Assemble
    const folder = await dataFolder();
    const launchd = fakeLaunchd(folder);
    const deps = agentDeps(folder, launchd);
    const nothing = stop(folder.dir, deps);
    await start(folder.dir, deps);

    // Act
    const stopped = stop(folder.dir, deps);
    await launchd.state.closing;

    // Assert
    expect([nothing, stopped]).toEqual([['not running'], ['stopped']]);
    expect(launchd.calls.at(-1)).toBe(
      `/bin/launchctl bootout gui/${String(UID)}/${agentLabel(folder.dir)}`,
    );
    expect(existsSync(plistPath(homeOf(folder), agentLabel(folder.dir)))).toBe(false);
  });

  test('should remove a plist left behind by an agent that is no longer loaded', async () => {
    const folder = await dataFolder();
    const launchd = fakeLaunchd(folder);
    const plist = plistPath(homeOf(folder), agentLabel(folder.dir));
    mkdirSync(join(homeOf(folder), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plist, 'left behind');
    expect(stop(folder.dir, agentDeps(folder, launchd))).toEqual(['stopped']);
    expect([existsSync(plist), launchd.calls.length]).toEqual([false, 1]);
  });

  test('should report a failed bootout', async () => {
    const folder = await dataFolder();
    const launchd = fakeLaunchd(folder, { bootout: 3 }, { loaded: true });
    expect(() => stop(folder.dir, agentDeps(folder, launchd))).toThrow(
      'launchctl bootout failed (exit 3): Boot-out failed: 3: No such process',
    );
  });

  test('should exit 0 on a refused start under launchd, non-zero on a crash', async () => {
    const folder = await dataFolder();
    const refused = await main(['serve', '--agent'], {
      ...mainDeps(folder),
      store: new MemoryStore(),
    });
    const plain = await main(['serve'], { ...mainDeps(folder), store: new MemoryStore() });
    const broken = Object.assign(new MemoryStore(), {
      read: () => {
        throw new Error('a bug');
      },
    });
    expect([refused.exitCode, refused.stderr]).toEqual([
      0,
      expect.stringMatching(/^amygdala serve: no key/) as unknown,
    ]);
    expect(plain.exitCode).toBe(1);
    await expect(
      main(['serve', '--agent'], { ...mainDeps(folder), store: broken }),
    ).rejects.toThrow('a bug');
  });
});

describe('main: start and stop', () => {
  test('should start and stop through the commands', async () => {
    const folder = await dataFolder();
    const launchd = fakeLaunchd(folder);
    const launch = {
      run: launchd.run,
      uid: UID,
      home: homeOf(folder),
      node: process.execPath,
      entry: ENTRY,
    };
    const deps = mainDeps(folder, undefined, { launch });
    const started = await main(['start'], deps);
    const stopped = await main(['stop'], deps);
    await launchd.state.closing;
    expect([started.exitCode, started.stdout]).toEqual([
      0,
      expect.stringMatching(/^started \(pid/) as unknown,
    ]);
    expect([stopped.exitCode, stopped.stdout]).toEqual([0, 'stopped\n']);
    expect(await queryStatus(folder.dir)).toBeUndefined();
  });
});

describe('main: start and stop, failures', () => {
  test('should exit 1 with the reason when start is refused', async () => {
    const folder = await dataFolder();
    const outcome = await main(['start'], { ...mainDeps(folder), store: new MemoryStore() });
    expect([outcome.exitCode, outcome.stderr]).toEqual([
      1,
      expect.stringMatching(/^amygdala start: no key/) as unknown,
    ]);
  });

  test('should exit 1 with the reason when stop is refused', async () => {
    const folder = await dataFolder();
    const launchd = fakeLaunchd(folder, { bootout: 3 }, { loaded: true });
    const launch = {
      run: launchd.run,
      uid: UID,
      home: homeOf(folder),
      node: process.execPath,
      entry: ENTRY,
    };
    const outcome = await main(['stop'], mainDeps(folder, undefined, { launch }));
    expect([outcome.exitCode, outcome.stderr]).toEqual([
      1,
      expect.stringMatching(/^amygdala stop: launchctl bootout failed/) as unknown,
    ]);
  });

  test('should let an unexpected failure in start or stop crash rather than hide it', async () => {
    const folder = await dataFolder();
    const broken = Object.assign(new MemoryStore(), {
      has: () => {
        throw new Error('a bug');
      },
    });
    await expect(main(['start'], { ...mainDeps(folder), store: broken })).rejects.toThrow('a bug');
    // The default launchd of mainDeps throws a plain Error on any call.
    await expect(main(['stop'], mainDeps(folder))).rejects.toThrow('launchctl must not run here');
  });

  test.each([
    [['start', '--now'], '--now', 'start'],
    [['stop', '--now'], '--now', 'stop'],
    [['serve', '--agent', '--now'], '--now', 'serve'],
  ])('should refuse an unknown option: %s', async (args, option, command) => {
    const folder = await dataFolder();
    const outcome = await main(args, mainDeps(folder));
    expect([outcome.exitCode, outcome.stderr]).toEqual([
      2,
      `amygdala ${command}: unknown option "${option}". Run amygdala --help.\n`,
    ]);
  });
});

describe('refusalOf', () => {
  test.each([
    ['InitError', new InitError('a')],
    ['KeychainError', new KeychainError('a')],
    ['ConfigError', new ConfigError('/f', 'a')],
    ['MintError', new MintError('a')],
    ['CertificateError', new CertificateError('a')],
    ['KeyError', new KeyError('a')],
    ['ServeError', new ServeError('a')],
    ['AgentError', new AgentError('a')],
    ['a file-system refusal', Object.assign(new Error('a'), { code: 'EACCES' })],
  ])('should report a refusal: %s', (label, error) => {
    expect(refusalOf(error)).toBe(error.message);
  });

  test.each([
    ['a plain error', new Error('a bug')],
    ['something thrown that is not an Error', 'a string'],
  ])('should treat anything else as a bug: %s', (label, error) => {
    expect(refusalOf(error)).toBeUndefined();
  });
});
