import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'vitest';
import type { Detector } from '../src/engine/detector.ts';
import { ownKeyEncodings } from '../src/engine/detectors/own-key.ts';
import { TokenMap } from '../src/engine/token-map.ts';
import { createScrubber, type Decision, type ScrubOptions } from '../src/scrub.ts';
import {
  call,
  type Call,
  cleanup,
  CUSTOMER,
  DATADOG,
  DETECTORS,
  HOST,
  ID,
  KEY,
  localForwarder,
  modelRequest,
  PLACEHOLDER,
  proxyWith,
  secureThrough,
  upstream,
} from './harness.ts';

afterEach(cleanup);

const KEY_HEX = Buffer.from(KEY).toString('hex');
const KEY_BASE64 = Buffer.from(KEY).toString('base64');

type Options = Partial<Pick<ScrubOptions, 'map' | 'maxBodyBytes' | 'detectors'>>;

/** The real proxy with a scrubber, in front of a recording upstream that answers "ok". */
async function scrubbing(options: Options = {}) {
  const up = await upstream((request, response) => response.end('ok'));
  const decisions: Decision[] = [];
  const waiting: (() => void)[] = [];
  const handler = createScrubber({
    key: KEY,
    detectors: DETECTORS,
    forward: localForwarder(up.port),
    report: (decision) => {
      decisions.push(decision);
      waiting.splice(0).forEach((wake) => {
        wake();
      });
    },
    ...options,
  });
  const proxy = await proxyWith(handler);
  const decided = async () => {
    while (decisions.length === 0) await new Promise<void>((wake) => waiting.push(wake));
    return decisions[0];
  };
  return { up, decisions, decided, port: proxy.port };
}

interface Blocked extends Call {
  readonly label: string;
  readonly reason: RegExp;
  readonly options?: Options;
}

/** Sends `blocked` and checks it was refused with a 400 before anything reached the upstream. */
async function expectBlocked(blocked: Blocked) {
  const { up, decided, port } = await scrubbing(blocked.options);
  const { reply, body } = await call(port, blocked);
  const decision = await decided();
  expect(reply.statusCode).toBe(400);
  expect(JSON.parse(body.toString())).toEqual({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: expect.stringMatching(/^amygdala blocked this request: /) as unknown,
    },
  });
  expect(body.toString()).toMatch(blocked.reason);
  expect([decision?.action, decision?.reason]).toEqual([
    'blocked',
    expect.stringMatching(blocked.reason),
  ]);
  expect(up.connections()).toBe(0);
  return { body: body.toString(), decision };
}

const OWN_KEY: Blocked[] = [
  { label: 'as hex', body: modelRequest(`key ${KEY_HEX}`), reason: /own key/ },
  { label: 'as base64', body: modelRequest(`key ${KEY_BASE64}`), reason: /own key/ },
];
const NOT_JSON: Blocked[] = [{ label: 'model request', body: 'not { json', reason: /not JSON/ }];
const COMPRESSED: Blocked[] = [
  {
    label: 'gzip',
    headers: { 'content-encoding': 'gzip' },
    body: gzipSync(JSON.stringify(modelRequest(ID))),
    reason: /compressed/,
  },
];
const throwing: Detector = {
  name: 'pattern:broken',
  prefix: 'BRK',
  find: () => {
    throw new Error('detector failed');
  },
};
const COLLISIONS: Blocked[] = [
  {
    label: 'two values, one placeholder',
    body: modelRequest(`${ID} and CUST-0002`),
    options: { map: new TokenMap(KEY, () => 'CUST_aaaaaaaaaa') },
    reason: /two values produced one placeholder/,
  },
  {
    label: 'two keys alike',
    body: { ...modelRequest('x'), metadata: { [ID]: 1, [PLACEHOLDER]: 2 } },
    reason: /two values produced one placeholder/,
  },
  {
    label: 'a scan that throws',
    body: modelRequest('x'),
    options: { detectors: [throwing] },
    reason: /scan failed/,
  },
];
const OTHER_PATHS: Blocked[] = [
  {
    label: 'Remote Control upload',
    path: '/v1/code/sessions/s1/worker/events',
    body: { events: [{ payload: { type: 'user', message: { content: `about ${ID}` } } }] },
    reason: /outside a model request \(pattern:customer-id: 1\)/,
  },
  {
    label: 'Datadog logs',
    host: DATADOG,
    path: '/api/v2/logs',
    body: [{ message: `saw ${ID}` }],
    reason: /outside a model request/,
  },
];
const OTHER_NOT_JSON: Blocked[] = [
  { label: 'form body', path: '/api/claude_code/metrics', body: 'a=1&b=2', reason: /not JSON/ },
];
const IN_PATH: Blocked = {
  label: 'path',
  method: 'GET',
  path: `/v1/code/sessions/${ID}/worker`,
  reason: /URL or headers/,
};
const IN_URL: Blocked[] = [
  IN_PATH,
  {
    label: 'a malformed escape next to the value',
    method: 'GET',
    path: `/api/search?q=%ZZ${ID}`,
    reason: /URL or headers/,
  },
  { label: 'query', method: 'GET', path: `/api/search?q=${ID}`, reason: /URL or headers/ },
  {
    label: 'percent-encoded query',
    method: 'GET',
    path: '/api/search?q=CUST%2D0001',
    reason: /URL or headers/,
  },
];
const IN_HEADER: Blocked[] = [
  { label: 'header', headers: { 'x-note': ID }, body: modelRequest('x'), reason: /URL or headers/ },
];
const MODEL_PATH_ELSEWHERE: Blocked[] = [
  {
    label: 'claude.ai',
    host: 'claude.ai',
    body: modelRequest(ID),
    reason: /outside a model request/,
  },
];

describe('createScrubber', () => {
  test('should replace every protected value in a model request with one placeholder', async () => {
    // Assemble
    const { up, decided, port } = await scrubbing();

    // Act
    const { reply } = await call(port, { body: modelRequest(ID) });

    // Assert
    const sent = up.seen[0]?.body.toString() ?? '';
    expect(reply.statusCode).toBe(200);
    expect(sent).not.toContain(ID);
    expect(sent.split(PLACEHOLDER).length - 1).toBe(5);
    expect(up.seen[0]?.headers['content-length']).toBe(String(Buffer.byteLength(sent)));
    expect(await decided()).toEqual({
      host: HOST,
      method: 'POST',
      path: '/v1/messages',
      action: 'tokenized',
      reason: undefined,
      hits: { [CUSTOMER]: 5 },
      images: 0,
      documents: 0,
      thread: false,
    });
  });

  test('should send a model request with no protected value as its original bytes', async () => {
    const { up, decided, port } = await scrubbing();
    const body = Buffer.from(JSON.stringify(modelRequest('nobody'), null, 2));
    await call(port, { body });
    expect(up.seen[0]?.body.equals(body)).toBe(true);
    expect((await decided())?.action).toBe('forwarded');
  });

  test('should tokenize a token-count request like a model request', async () => {
    const { up, decided, port } = await scrubbing();
    await call(port, { path: '/v1/messages/count_tokens?beta=true', body: modelRequest(ID) });
    expect(up.seen[0]?.body.toString()).toContain(PLACEHOLDER);
    expect((await decided())?.action).toBe('tokenized');
  });

  test('should leave image and document data untouched and count them', async () => {
    // Assemble
    const { up, decided, port } = await scrubbing();
    const image = { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoCUST0001' };
    const pdf = { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQKCUST0001' };
    const content = [
      { type: 'text', text: `Look at ${ID}` },
      { type: 'image', source: image },
      { type: 'document', source: pdf },
    ];
    const body = { ...modelRequest(ID), messages: [{ role: 'user', content }] };

    // Act
    await call(port, { body });

    // Assert
    const sent = JSON.parse(up.seen[0]?.body.toString() ?? '{}') as typeof body;
    expect(sent.messages[0]?.content.slice(1)).toEqual([
      { type: 'image', source: image },
      { type: 'document', source: pdf },
    ]);
    expect(await decided()).toMatchObject({ action: 'tokenized', images: 1, documents: 1 });
  });

  test.each(OWN_KEY)(
    "should block a request holding amygdala's own key: $label",
    async (blocked) => {
      await expectBlocked(blocked);
    },
  );

  test.each(NOT_JSON)(
    "should block a model request whose body isn't JSON: $label",
    async (blocked) => {
      await expectBlocked(blocked);
    },
  );

  test('should block a body over the size limit without reading the rest', async () => {
    // Assemble
    const { up, decided, port } = await scrubbing({ maxBodyBytes: 64 });
    const secure = await secureThrough(port);

    // Act: 100 bytes of a promised 1000 arrive, and the request is never finished
    const status = await new Promise<number | undefined>((resolve) => {
      const request = http.request(
        {
          method: 'POST',
          path: '/v1/messages',
          headers: { host: HOST, 'content-length': 1000 },
          createConnection: () => secure,
        },
        (reply) => {
          resolve(reply.statusCode);
          reply.resume();
        },
      );
      // The proxy hangs up on the unread rest, which this client may hear as an error.
      request.on('error', () => undefined);
      request.write(Buffer.alloc(100, 'a'));
    });

    // Assert
    expect(status).toBe(400);
    expect((await decided())?.reason).toMatch(/over 64 bytes/);
    expect(up.connections()).toBe(0);
  });

  test.each(COMPRESSED)('should block a compressed body: $label', async (blocked) => {
    await expectBlocked(blocked);
  });

  test.each(COLLISIONS)('should block a placeholder or key collision: $label', async (blocked) => {
    await expectBlocked(blocked);
  });

  test.each(OTHER_PATHS)(
    'should block a protected value on any other path or intercept host: $label',
    async (blocked) => {
      const { decision } = await expectBlocked(blocked);
      expect(decision?.hits).toEqual({ [CUSTOMER]: 1 });
    },
  );

  test.each([
    { label: 'a JSON POST', method: 'POST', body: Buffer.from('{ "events": [ {"name": "x"} ] }') },
    { label: 'a GET with no body', method: 'GET', body: undefined },
    { label: 'an empty POST', method: 'POST', body: undefined },
  ])(
    'should forward a request on another path with no protected value byte for byte: $label',
    async ({ method, body }) => {
      const { up, decided, port } = await scrubbing();
      const { reply } = await call(port, { method, path: '/api/event_logging/v2/batch', body });
      expect(reply.statusCode).toBe(200);
      expect(up.seen[0]?.body.equals(body ?? Buffer.alloc(0))).toBe(true);
      expect(up.seen[0]?.method).toBe(method);
      expect((await decided())?.action).toBe('forwarded');
    },
  );

  test.each(OTHER_NOT_JSON)(
    "should block a body that isn't JSON on another path: $label",
    async (blocked) => {
      await expectBlocked(blocked);
    },
  );

  test.each(IN_URL)(
    'should block a protected value in the URL, decoded or not: $label',
    async (blocked) => {
      const { decision } = await expectBlocked(blocked);
      expect(decision?.path).not.toContain(ID);
    },
  );

  test('should show a placeholder for a value in the blocked path', async () => {
    const { decision } = await expectBlocked(IN_PATH);
    expect(decision?.path).toBe(`/v1/code/sessions/${PLACEHOLDER}/worker`);
  });

  test.each(IN_HEADER)('should block a protected value in a header: $label', async (blocked) => {
    await expectBlocked(blocked);
  });

  test.each(MODEL_PATH_ELSEWHERE)(
    'should treat a model path on another host as another path: $label',
    async (blocked) => {
      await expectBlocked(blocked);
    },
  );

  test('should not connect upstream until the whole body has arrived', async () => {
    // Assemble
    const { up, port } = await scrubbing();
    const secure = await secureThrough(port);
    const body = Buffer.from(JSON.stringify(modelRequest(ID)));
    const half = Math.floor(body.length / 2);
    let duringPause = -1;

    // Act: half the body, a pause, then the rest
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request(
        {
          method: 'POST',
          path: '/v1/messages',
          headers: { host: HOST, 'content-length': body.length },
          createConnection: () => secure,
        },
        (reply) => {
          reply.resume();
          reply.on('end', () => {
            resolve(reply.statusCode);
          });
        },
      );
      request.on('error', reject);
      request.write(body.subarray(0, half));
      setTimeout(() => {
        duringPause = up.connections();
        request.end(body.subarray(half));
      }, 100);
    });

    // Assert
    expect(duringPause).toBe(0);
    expect(status).toBe(200);
    expect(up.seen[0]?.body.toString()).toContain(PLACEHOLDER);
  });

  test('should send nothing when the client leaves mid-body', async () => {
    // Assemble
    const { up, decided, port } = await scrubbing();
    const secure = await secureThrough(port);

    // Act
    const request = http.request({
      method: 'POST',
      path: '/v1/messages',
      headers: { host: HOST, 'content-length': 1000 },
      createConnection: () => secure,
    });
    request.on('error', () => undefined);
    request.write(`{"note": "${ID}`, () => secure.destroy());

    // Assert
    expect(await decided()).toMatchObject({
      action: 'blocked',
      reason: expect.stringMatching(/left/) as unknown,
    });
    expect(up.connections()).toBe(0);
  });

  test('should report whether a model request carries a thread field', async () => {
    const { decided, port } = await scrubbing();
    await call(port, { body: { ...modelRequest(ID), thread: { id: 'thread_1' } } });
    expect((await decided())?.thread).toBe(true);
  });

  test.each([
    ...OWN_KEY,
    ...NOT_JSON,
    ...COMPRESSED,
    ...COLLISIONS,
    ...OTHER_PATHS,
    ...OTHER_NOT_JSON,
    ...IN_URL,
    ...IN_HEADER,
    ...MODEL_PATH_ELSEWHERE,
  ])(
    'should never put a value or the key in a block message or a decision: $label',
    async (blocked) => {
      const { body, decision } = await expectBlocked(blocked);
      const output = `${body}\n${JSON.stringify(decision)}`.toLowerCase();
      for (const secret of [ID, 'CUST-0002', ...ownKeyEncodings(KEY)]) {
        expect(output).not.toContain(secret.toLowerCase());
      }
    },
  );
});
