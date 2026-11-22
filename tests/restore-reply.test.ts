import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import type tls from 'node:tls';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'vitest';
import type { TrustOptions } from '../src/engine/trust.ts';
import { createScrubber } from '../src/scrub.ts';
import {
  call,
  cleanup,
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

const FIXTURES = join(import.meta.dirname, 'fixtures', 'claude-code');
const SSE = { 'content-type': 'text/event-stream' };
const JSON_TYPE = { 'content-type': 'application/json' };

// Events in the API's own framing, so an event nobody changes can be compared byte for byte.
const event = (name: string, data: Record<string, unknown>) =>
  `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
const MESSAGE_START = event('message_start', {
  message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude' },
});
const MESSAGE_END =
  event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }) +
  event('message_stop', {});
const start = (index: number, block: Record<string, unknown>) =>
  event('content_block_start', { index, content_block: block });
const delta = (index: number, change: Record<string, unknown>) =>
  event('content_block_delta', { index, delta: change });
const stop = (index: number) => event('content_block_stop', { index });
const text = (index: number, pieces: string[]) =>
  start(index, { type: 'text', text: '' }) +
  pieces.map((piece) => delta(index, { type: 'text_delta', text: piece })).join('') +
  stop(index);
const tool = (index: number, name: string, json: string) =>
  start(index, { type: 'tool_use', id: `toolu_${String(index)}`, name, input: {} }) +
  delta(index, { type: 'input_json_delta', partial_json: json }) +
  stop(index);
const stream = (...blocks: string[]) => MESSAGE_START + blocks.join('') + MESSAGE_END;

/** What the client received for each block: text deltas and tool arguments, joined. */
function received(body: string): Map<number, string> {
  const blocks = new Map<number, string>();
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = JSON.parse(line.slice('data: '.length)) as {
      type: string;
      index: number;
      delta?: { text?: string; partial_json?: string };
    };
    if (data.type !== 'content_block_delta') continue;
    const piece = data.delta?.text ?? data.delta?.partial_json ?? '';
    blocks.set(data.index, (blocks.get(data.index) ?? '') + piece);
  }
  return blocks;
}

/** The real proxy with a scrubber in front of an upstream that answers with `answer`. */
async function restoring(answer: http.RequestListener, trust?: TrustOptions) {
  const up = await upstream(answer);
  const handler = createScrubber({
    key: KEY,
    detectors: DETECTORS,
    forward: localForwarder(up.port),
    report: () => undefined,
    ...(trust === undefined ? {} : { trust }),
  });
  return { up, port: (await proxyWith(handler)).port };
}

/**
 * An upstream that streams `body` as an event stream, declaring its length: restoring changes the
 * length, so the proxy must not pass that header on.
 */
const streaming =
  (body: string): http.RequestListener =>
  (request, response) => {
    response.writeHead(200, { ...SSE, 'content-length': Buffer.byteLength(body) }).end(body);
  };

/** One model request carrying ID through the proxy, so its placeholder is issued first. */
const ask = (port: number) => call(port, { body: modelRequest(ID) });

/** Sends a model request and resolves when the reply closes, with whether it finished. */
async function untilClosed(port: number, onData?: (secure: tls.TLSSocket) => void) {
  const secure = await secureThrough(port);
  return new Promise<{ status: number | undefined; complete: boolean }>((resolve, reject) => {
    const request = http.request(
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { host: HOST },
        createConnection: () => secure,
      },
      (reply) => {
        reply.on('data', () => onData?.(secure));
        reply.on('close', () => {
          resolve({ status: reply.statusCode, complete: reply.complete });
        });
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(modelRequest(ID)));
  });
}

describe('restoring replies', () => {
  test('should restore a placeholder in streamed text and leave thinking and signatures alone', async () => {
    // Assemble
    const reply = (value: string) =>
      stream(
        start(0, { type: 'thinking', thinking: '' }) +
          delta(0, { type: 'thinking_delta', thinking: `About ${PLACEHOLDER}.` }) +
          delta(0, { type: 'signature_delta', signature: 'c2lnbmVk' }) +
          stop(0),
        text(1, [`Found ${value}.`]),
      );
    const { port } = await restoring(streaming(reply(PLACEHOLDER)));

    // Act
    const { body } = await ask(port);

    // Assert: only the text changed, to exactly what the API would have sent with the real value
    expect(body.toString()).toBe(reply(ID));
  });

  test('should restore a placeholder split across two text deltas', async () => {
    const cut = 7;
    const pieces = [`Found ${PLACEHOLDER.slice(0, cut)}`, `${PLACEHOLDER.slice(cut)} ok`];
    const { port } = await restoring(streaming(stream(text(0, pieces))));
    const { body } = await ask(port);
    expect(received(body.toString()).get(0)).toBe(`Found ${ID} ok`);
  });

  test('should stream a restored reply as it arrives', async () => {
    // Assemble: the upstream holds the rest of its reply until the client has seen the start
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { port } = await restoring((request, response) => {
      response.writeHead(200, SSE).write(MESSAGE_START);
      void held.then(() => response.end(text(0, [`Found ${PLACEHOLDER}.`]) + MESSAGE_END));
    });
    const secure = await secureThrough(port);

    // Act: the first chunk releases the upstream, which only works if nothing was buffered
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        {
          method: 'POST',
          path: '/v1/messages',
          headers: { host: HOST },
          createConnection: () => secure,
        },
        (reply) => {
          let all = '';
          reply.on('data', (chunk: Buffer) => {
            all += chunk.toString();
            release();
          });
          reply.on('end', () => {
            resolve(all);
          });
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify(modelRequest(ID)));
    });

    // Assert
    expect(received(body).get(0)).toBe(`Found ${ID}.`);
  });

  test('should keep a multi-byte character split across chunks intact', async () => {
    // Assemble: the reply's bytes are cut inside the three bytes of "☕"
    const bytes = Buffer.from(stream(text(0, ['café ☕ ok'])));
    const cut = bytes.indexOf(Buffer.from('☕')) + 1;
    const { port } = await restoring((request, response) => {
      response.writeHead(200, SSE).write(bytes.subarray(0, cut));
      setTimeout(() => response.end(bytes.subarray(cut)), 50);
    });

    // Act
    const { body } = await ask(port);

    // Assert
    expect(received(body.toString()).get(0)).toBe('café ☕ ok');
  });

  test.each([
    { label: 'the built-in list', trust: undefined, bash: ID, webFetch: PLACEHOLDER },
    {
      label: 'a configured list',
      trust: { trustedTools: ['WebFetch'] },
      bash: PLACEHOLDER,
      webFetch: ID,
    },
  ])(
    "should restore a trusted tool's arguments and leave an untrusted tool's alone: $label",
    async ({ trust, bash, webFetch }) => {
      const { port } = await restoring(
        streaming(
          stream(
            tool(0, 'Bash', `{"command": "echo ${PLACEHOLDER}"}`),
            tool(1, 'WebFetch', `{"url": "https://example.test/${PLACEHOLDER}"}`),
          ),
        ),
        trust,
      );
      const blocks = received((await ask(port)).body.toString());
      expect(JSON.parse(blocks.get(0) ?? '')).toEqual({ command: `echo ${bash}` });
      expect(JSON.parse(blocks.get(1) ?? '')).toEqual({ url: `https://example.test/${webFetch}` });
    },
  );

  test('should send held text when the stream ends without closing its block', async () => {
    // Assemble: the last event has no closing blank line and leaves its block open, holding "USA"
    const open = MESSAGE_START + start(0, { type: 'text', text: '' });
    const last = delta(0, { type: 'text_delta', text: `${PLACEHOLDER} in the USA` }).trimEnd();
    const { port } = await restoring(streaming(open + last));

    // Act
    const { body } = await ask(port);

    // Assert
    expect(received(body.toString()).get(0)).toBe(`${ID} in the USA`);
  });

  test('should restore a whole JSON reply with a matching content-length', async () => {
    // Assemble
    const message = (value: string) => ({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: `Found ${value}.` },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Read',
          input: { file_path: `/data/${value}.csv` },
        },
      ],
    });
    const { port } = await restoring((request, response) => {
      response.writeHead(200, JSON_TYPE).end(JSON.stringify(message(PLACEHOLDER)));
    });

    // Act
    const { reply, body } = await ask(port);

    // Assert
    expect(JSON.parse(body.toString())).toEqual(message(ID));
    expect(reply.headers['content-length']).toBe(String(body.length));
  });

  test.each(readdirSync(FIXTURES))(
    'should pass every recorded reply through byte for byte when nothing is issued: %s',
    async (name) => {
      // Assemble: the recording, sent in three pieces
      const recorded = readFileSync(join(FIXTURES, name, 'response.sse'));
      const third = Math.ceil(recorded.length / 3);
      const { port } = await restoring((request, response) => {
        response.writeHead(200, SSE);
        response.write(recorded.subarray(0, third));
        response.write(recorded.subarray(third, 2 * third));
        response.end(recorded.subarray(2 * third));
      });

      // Act
      const { body } = await call(port, { body: modelRequest('nobody') });

      // Assert: nothing was issued, so nothing is held back and no event is rewritten
      expect(body.equals(recorded)).toBe(true);
    },
  );

  test('should restore a placeholder from an earlier request in a reply to a clean one', async () => {
    const { port } = await restoring(streaming(stream(text(0, [`Still ${PLACEHOLDER}.`]))));
    await ask(port);
    const { body } = await call(port, { body: modelRequest('nobody') });
    expect(received(body.toString()).get(0)).toBe(`Still ${ID}.`);
  });

  test('should leave a placeholder amygdala never issued alone', async () => {
    const reply = stream(text(0, ['Not ours: CUST_aaaaaaaaaa.']));
    const { port } = await restoring(streaming(reply));
    expect((await ask(port)).body.toString()).toBe(reply);
  });

  test('should ask the upstream for an uncompressed reply on model requests only', async () => {
    const { up, port } = await restoring((request, response) => response.end('{}'));
    const headers = { 'accept-encoding': 'gzip, br' };
    await call(port, { headers, body: modelRequest(ID) });
    await call(port, { headers, path: '/api/event_logging/v2/batch', body: { events: [] } });
    expect(up.seen.map((seen) => seen.headers['accept-encoding'])).toEqual([
      'identity',
      'gzip, br',
    ]);
  });

  test('should answer 502 for a model reply that arrives compressed', async () => {
    const { port } = await restoring((request, response) => {
      response
        .writeHead(200, { ...SSE, 'content-encoding': 'gzip' })
        .end(gzipSync(stream(text(0, [`Found ${PLACEHOLDER}.`]))));
    });
    const { reply, body } = await ask(port);
    expect([reply.statusCode, body.length]).toEqual([502, 0]);
  });

  test.each([
    {
      label: 'a 400 JSON error',
      status: 400,
      headers: JSON_TYPE,
      body: '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}',
    },
    {
      label: 'a 529 overloaded',
      status: 529,
      headers: JSON_TYPE,
      body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    },
    {
      label: 'an error event inside a stream',
      status: 200,
      headers: SSE,
      body:
        MESSAGE_START +
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    },
  ])('should pass error replies through unchanged: $label', async ({ status, headers, body }) => {
    const { port } = await restoring((request, response) => {
      response.writeHead(status, headers).end(body);
    });
    const { reply, body: got } = await ask(port);
    expect([reply.statusCode, got.toString()]).toEqual([status, body]);
  });

  test('should cut the client off when the upstream fails mid-stream', async () => {
    const { port } = await restoring((request, response) => {
      response.writeHead(200, SSE).write(MESSAGE_START, () => response.socket?.destroy());
    });
    expect(await untilClosed(port)).toEqual({ status: 200, complete: false });
  });

  test('should close the upstream when the client leaves mid-stream', async () => {
    // Assemble: the upstream sends the start of a reply and never finishes it
    let upstreamClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const { port } = await restoring((request, response) => {
      response.on('close', upstreamClosed);
      response.writeHead(200, SSE).write(MESSAGE_START);
    });

    // Act: the client hangs up as soon as the reply starts
    void untilClosed(port, (secure) => {
      secure.destroy();
    }).catch(() => undefined);

    // Assert: resolves only if the proxy closed its upstream connection
    await closed;
  });

  test('should leave replies on other paths untouched', async () => {
    const message = JSON.stringify({
      type: 'message',
      content: [{ type: 'text', text: PLACEHOLDER }],
    });
    const { port } = await restoring((request, response) => {
      response.writeHead(200, JSON_TYPE).end(message);
    });
    await ask(port);
    const { body } = await call(port, { method: 'GET', path: '/api/claude_code/settings' });
    expect(body.toString()).toBe(message);
  });
});
