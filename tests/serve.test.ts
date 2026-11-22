import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CA_FILE } from '../src/cert-store.ts';
import { CONFIG_FILE } from '../src/config.ts';
import { ownKeyEncodings } from '../src/engine/detectors/own-key.ts';
import { KeychainError } from '../src/keychain.ts';
import { EXIT_NOT_RUNNING, main, processSignals, stderrLine } from '../src/run.ts';
import { queryStatus, serve } from '../src/serve.ts';
import {
  CLEANUP,
  cleanup,
  dataFolder,
  type Folder,
  ID,
  listening,
  mainDeps,
  modelRequest,
  reads,
  secureThrough,
  send,
} from './harness.ts';
import { MemoryStore } from './memory-store.ts';

afterEach(cleanup);

async function started(folder: Folder, deps: Partial<Folder['deps']> = {}) {
  const running = await serve(folder.dir, { ...folder.deps, ...deps });
  CLEANUP.push(() => running.close());
  return running;
}

/** One request through the running proxy, trusting the folder's own CA. */
async function through(folder: Folder, path: string, body: object) {
  const ca = readFileSync(join(folder.dir, CA_FILE), 'utf8');
  const secure = await secureThrough(folder.port, ca);
  return send(secure, { method: 'POST', path }, Buffer.from(JSON.stringify(body)));
}

/** A socket at `path` left behind by a process that was killed. */
async function staleSocket(path: string) {
  const child = spawn(process.execPath, [
    '-e',
    "require('net').createServer().listen(process.argv[1], () => console.log('up'))",
    path,
  ]);
  await new Promise<void>((resolve) =>
    child.stdout.once('data', () => {
      resolve();
    }),
  );
  const gone = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await gone;
}

describe('serve', () => {
  test('should scrub a model request on the configured port', async () => {
    const folder = await dataFolder();
    const running = await started(folder);
    const { reply } = await through(folder, '/v1/messages', modelRequest(ID));
    const sent = folder.up.seen[0]?.body.toString() ?? '';
    expect([running.port, reply.statusCode]).toEqual([folder.port, 200]);
    expect(sent).not.toContain(ID);
    expect(sent).toMatch(/CUST_[a-z2-7]{10}/);
  });

  test('should start with the real forwarder when none is given, sending nothing until asked', async () => {
    const folder = await dataFolder();
    const { forward, ...real } = folder.deps;
    const running = await serve(folder.dir, real);
    CLEANUP.push(() => running.close());
    expect([typeof forward, (await queryStatus(folder.dir))?.port]).toEqual([
      'function',
      folder.port,
    ]);
  });

  test.each([
    ['the key', () => ({ store: new MemoryStore() }) as const, /no key for .*amygdala init/],
    [
      'the config',
      (f: Folder) => (rmSync(join(f.dir, CONFIG_FILE)), {}),
      /no config here: run `amygdala init`/,
    ],
    [
      'the certificates',
      (f: Folder) => (rmSync(join(f.dir, CA_FILE)), {}),
      /no usable certificates .*amygdala init/,
    ],
  ])(
    'should refuse to start when the key, config or certificates are missing: %s',
    async (label, breakIt, message) => {
      const folder = await dataFolder();
      const deps = breakIt(folder);
      await expect(serve(folder.dir, { ...folder.deps, ...deps })).rejects.toThrow(message);
      expect([await listening(folder.port), existsSync(folder.socket)]).toEqual([false, false]);
    },
  );

  test('should refuse a taken port without reading the key', async () => {
    // Assemble
    const folder = await dataFolder();
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(folder.port, '127.0.0.1', resolve));
    CLEANUP.push(() => new Promise((resolve) => holder.close(resolve)));

    // Act and Assert
    await expect(serve(folder.dir, folder.deps)).rejects.toThrow(
      new RegExp(`cannot listen on port ${String(folder.port)} \\(.*EADDRINUSE`),
    );
    expect([reads(folder.store), existsSync(folder.socket)]).toEqual([0, false]);
  });

  test('should refuse a second serve for the same data folder without reading the key', async () => {
    const folder = await dataFolder();
    await started(folder);
    await expect(serve(folder.dir, folder.deps)).rejects.toThrow(
      new RegExp(`already running for .* \\(pid ${String(process.pid)}\\)`),
    );
    expect(reads(folder.store)).toBe(1);
  });

  test.each([
    ['JSON that is not a status', '{}'],
    ['text that is not JSON', 'hello'],
  ])(
    'should refuse to start when another program holds the control socket: %s',
    async (label, answer) => {
      // Assemble: something that answers, but not as a serve
      const folder = await dataFolder();
      const squatter = net.createServer((client) => client.resume().end(answer));
      await new Promise<void>((resolve) => squatter.listen(folder.socket, resolve));
      CLEANUP.push(() => new Promise((resolve) => squatter.close(resolve)));

      // Act
      const outcome = await main(['serve'], mainDeps(folder));

      // Assert
      expect([outcome.exitCode, outcome.stderr]).toEqual([
        1,
        expect.stringMatching(/EADDRINUSE/) as unknown,
      ]);
      expect([reads(folder.store), await listening(folder.port)]).toEqual([0, false]);
    },
  );

  test('should refuse a data folder it cannot write the socket into', async () => {
    const folder = await dataFolder();
    chmodSync(folder.dir, 0o500);
    CLEANUP.push(() => {
      chmodSync(folder.dir, 0o700);
    });
    await expect(serve(folder.dir, folder.deps)).rejects.toThrow(/EACCES/);
    expect([reads(folder.store), await listening(folder.port)]).toEqual([0, false]);
  });

  test('should refuse, and never delete, a file at the socket path that is not a socket', async () => {
    const folder = await dataFolder();
    writeFileSync(folder.socket, 'not a socket');
    await expect(serve(folder.dir, folder.deps)).rejects.toThrow(/ENOTSOCK/);
    const status = await main(['status'], mainDeps(folder));
    expect([status.exitCode, status.stderr]).toEqual([
      1,
      expect.stringMatching(/^amygdala status: .*ENOTSOCK/) as unknown,
    ]);
    expect(readFileSync(folder.socket, 'utf8')).toBe('not a socket');
  });

  test('should report its state through status while running', async () => {
    // Assemble
    const folder = await dataFolder();
    await started(folder);
    const before = await main(['status'], mainDeps(folder));
    await through(folder, '/v1/messages', modelRequest(ID));

    // Act
    const status = await queryStatus(folder.dir);
    const after = await main(['status'], mainDeps(folder));

    // Assert
    expect(status).toEqual({
      running: true,
      version: 'test',
      pid: process.pid,
      port: folder.port,
      startedAt: expect.any(String) as unknown,
      detectors: ['pattern:customer-id', 'builtin:own-key'],
      requests: { forwarded: 0, tokenized: 1, blocked: 0 },
      hits: { 'pattern:customer-id': 5 },
    });
    expect(before.stdout).toContain('hits      none');
    expect([after.exitCode, after.stdout]).toEqual([
      0,
      expect.stringMatching(
        new RegExp(
          `^running   pid ${String(process.pid)}, port ${String(folder.port)}, .*\\nrequests  1 tokenized, 0 forwarded, 0 blocked\\nhits      pattern:customer-id 5\\n$`,
          's',
        ),
      ) as unknown,
    ]);
  });

  test('should report not running, and remove a stale socket', async () => {
    // Assemble
    const folder = await dataFolder();
    const nothing = await main(['status'], mainDeps(folder));
    await staleSocket(folder.socket);
    const leftBehind = existsSync(folder.socket);

    // Act
    const stale = await main(['status'], mainDeps(folder));

    // Assert
    for (const outcome of [nothing, stale]) {
      expect([outcome.exitCode, outcome.stderr]).toEqual([
        EXIT_NOT_RUNNING,
        'amygdala: not running: amygdala start\n',
      ]);
    }
    expect([leftBehind, existsSync(folder.socket)]).toEqual([true, false]);
  });

  test('should start over a stale socket left by a crash', async () => {
    const folder = await dataFolder();
    await staleSocket(folder.socket);
    await started(folder);
    expect((await queryStatus(folder.dir))?.pid).toBe(process.pid);
  });

  test('should keep the control socket private to the owner', async () => {
    const folder = await dataFolder();
    const running = await started(folder);
    expect([dirname(running.socket), statSync(running.socket).mode & 0o777]).toEqual([
      folder.dir,
      0o600,
    ]);
  });

  test.each(['SIGTERM', 'SIGINT'])(
    'should stop listening and remove the socket on SIGTERM and SIGINT: %s',
    async (signal) => {
      // Assemble: serve hands its stop to the test instead of the process
      const folder = await dataFolder();
      let stop: () => void = () => undefined;
      let registered: readonly string[] = [];
      const ready = new Promise<void>((resolve) => {
        const outcome = main(
          ['serve'],
          mainDeps(folder, (signals, handler) => {
            registered = signals;
            stop = handler;
            resolve();
          }),
        );
        CLEANUP.push(() => outcome);
      });
      await ready;
      const wasListening = await listening(folder.port);

      // Act: the signal arrives
      stop();
      await (CLEANUP.at(-1) as () => Promise<unknown>)();

      // Assert
      expect(registered).toContain(signal);
      expect([wasListening, await listening(folder.port), existsSync(folder.socket)]).toEqual([
        true,
        false,
        false,
      ]);
    },
  );

  test('should stop even with a client still attached to the control socket', async () => {
    const folder = await dataFolder();
    const running = await serve(folder.dir, folder.deps);
    const idle = net.connect(folder.socket);
    await new Promise((resolve) => idle.once('connect', resolve));
    await running.close();
    expect([await listening(folder.port), existsSync(folder.socket)]).toEqual([false, false]);
  });

  test('should log one line per request with no value or key in it', async () => {
    // Assemble
    const folder = await dataFolder();
    await started(folder);
    const key = Uint8Array.from(Buffer.from(folder.store.secrets.get(folder.dir) ?? '', 'hex'));

    // Act: one tokenized in thread mode, one blocked for the key, one blocked on another path
    await through(folder, '/v1/messages', { ...modelRequest(ID), thread: { id: 't1' } });
    await through(folder, '/v1/messages', modelRequest(Buffer.from(key).toString('hex')));
    await through(folder, '/api/event_logging/v2/batch', { note: ID });

    // Assert
    const requests = folder.lines.filter((line) => !line.includes(' listening on '));
    expect(requests.map((line) => line.split(' ')[1])).toEqual(['tokenized', 'blocked', 'blocked']);
    expect(requests[0]).toMatch(/ pattern:customer-id=5 thread$/);
    const text = folder.lines.join('\n').toLowerCase();
    for (const secret of [ID, ...ownKeyEncodings(key)])
      expect(text).not.toContain(secret.toLowerCase());
  });

  test('should read the key exactly once', async () => {
    const folder = await dataFolder();
    await started(folder);
    await through(folder, '/v1/messages', modelRequest(ID));
    await through(folder, '/v1/messages', modelRequest(ID));
    expect(reads(folder.store)).toBe(1);
  });
});

describe('main: serve and status', () => {
  test.each([
    [
      'a taken port (ServeError)',
      async (f: Folder) => {
        const holder = net.createServer();
        await new Promise<void>((resolve) => holder.listen(f.port, '127.0.0.1', resolve));
        CLEANUP.push(() => new Promise((resolve) => holder.close(resolve)));
        return {};
      },
      /cannot listen on port/,
    ],
    [
      'no config (ConfigError)',
      (f: Folder) => (rmSync(join(f.dir, CONFIG_FILE)), Promise.resolve({})),
      /no config/,
    ],
    [
      'no certificates (CertificateError)',
      (f: Folder) => (rmSync(join(f.dir, CA_FILE)), Promise.resolve({})),
      /no usable certificates/,
    ],
    ['no key (KeyError)', () => Promise.resolve({ store: new MemoryStore() }), /no key/],
    [
      'a Keychain failure (KeychainError)',
      () =>
        Promise.resolve({
          store: Object.assign(new MemoryStore(), {
            read: () => {
              throw new KeychainError('dialog denied');
            },
          }),
        }),
      /dialog denied/,
    ],
  ])('should exit 1 with the reason when serve is refused: %s', async (label, breakIt, message) => {
    const folder = await dataFolder();
    const override = await breakIt(folder);
    const outcome = await main(['serve'], {
      ...mainDeps(folder, undefined, { local: false }),
      ...override,
    });
    expect([outcome.exitCode, outcome.stderr]).toEqual([
      1,
      expect.stringMatching(message) as unknown,
    ]);
    expect(outcome.stderr).toMatch(/^amygdala serve: /);
  });

  test('should let an unexpected failure crash rather than hide it', async () => {
    const folder = await dataFolder();
    const store = Object.assign(new MemoryStore(), {
      read: () => {
        throw new Error('a bug');
      },
    });
    await expect(main(['serve'], { ...mainDeps(folder), store })).rejects.toThrow('a bug');
  });

  test.each(['serve', 'status'])('should refuse an unknown option: %s', async (command) => {
    const folder = await dataFolder();
    const outcome = await main([command, '--now'], mainDeps(folder));
    expect([outcome.exitCode, outcome.stderr]).toEqual([
      2,
      `amygdala ${command}: unknown option "--now". Run amygdala --help.\n`,
    ]);
  });

  test('should hand other commands to run, with the real dependencies by default', async () => {
    expect((await main(['--version'])).exitCode).toBe(0);
  });

  test('should write serve lines to stderr', () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    stderrLine('a line');
    spy.mockRestore();
    expect(written).toEqual(['a line\n']);
  });

  test('should stop on the first of the process signals it was given', () => {
    let stops = 0;
    processSignals(['SIGUSR2'], () => (stops += 1));
    process.emit('SIGUSR2', 'SIGUSR2');
    process.emit('SIGUSR2', 'SIGUSR2');
    expect(stops).toBe(1);
  });
});
