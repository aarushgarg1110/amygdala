import { readdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { StreamParser, formatEvent, type StreamEvent } from '../../src/engine/stream.ts';
import { FIXTURES, cut, delta, event, parse, recorded, start, stop } from './sse.ts';

const SCENARIOS = readdirSync(FIXTURES);
// The recordings only use LF; the spec also allows CRLF and CR, whose CR can end a chunk.
const STREAMS: [string, string][] = [
  ...SCENARIOS.map((scenario): [string, string] => [scenario, recorded(scenario)]),
  ['text-reply with CRLF', recorded('text-reply').replaceAll('\n', '\r\n')],
  ['text-reply with CR', recorded('text-reply').replaceAll('\n', '\r')],
];

describe('StreamParser', () => {
  test.each(SCENARIOS)(
    'should split each recorded stream into its events and give back the same bytes: %s',
    (scenario) => {
      // Assemble
      const sse = recorded(scenario);

      // Act
      const events = parse(sse);

      // Assert: one event per blank-line-separated group, named as its event line says
      const groups = sse.split('\n\n').filter((group) => group !== '');
      expect(events.map((e) => e.name)).toEqual(groups.map((g) => /^event: (.+)$/m.exec(g)?.[1]));
      expect(events.map((e) => (e.data as { type: string }).type)).toEqual(
        events.map((e) => e.name),
      );
      expect(events.map((e) => e.raw).join('')).toBe(sse);
    },
  );

  test.each(STREAMS)(
    'should give the same events wherever a chunk boundary falls: %s',
    (label, sse) => {
      // Assemble
      const whole = parse(sse);

      // Act
      const wrong = [...Array(sse.length + 1).keys()].filter(
        (at) => !isDeepStrictEqual(parse(sse.slice(0, at), sse.slice(at)), whole),
      );

      // Assert: every split position, and one character per chunk
      expect(wrong).toEqual([]);
      expect(parse(...sse.split(''))).toEqual(whole);
    },
  );

  test.each(STREAMS)('should give the same events for any chunk sizes: %s', (label, sse) => {
    const whole = parse(sse);
    fc.assert(
      fc.property(fc.array(fc.nat({ max: sse.length }), { maxLength: 60 }), (points) =>
        isDeepStrictEqual(parse(...cut(sse, points)), whole),
      ),
    );
  });

  test("should tag deltas with their block's type and tool name", () => {
    // Assemble: thinking, then a Read call at index 1, then text
    const sse = [
      start(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'Reading the file.' }),
      stop(0),
      start(1, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }),
      delta(1, { type: 'input_json_delta', partial_json: '{"file_path": "/tmp/a.csv"}' }),
      stop(1),
      start(2, { type: 'text', text: '' }),
      delta(2, { type: 'text_delta', text: 'Done.' }),
    ].join('');

    // Act
    const blocks = parse(sse).map((e) => e.block);

    // Assert
    const thinking = { index: 0, type: 'thinking', name: undefined };
    const read = { index: 1, type: 'tool_use', name: 'Read' };
    const text = { index: 2, type: 'text', name: undefined };
    expect(blocks).toEqual([thinking, thinking, thinking, read, read, read, text, text]);
  });

  test.each([
    [
      'never started, while another is open',
      start(0, { type: 'text' }) + delta(5, { type: 'text_delta' }),
    ],
    ['already stopped', start(0, { type: 'text' }) + stop(0) + delta(0, { type: 'text_delta' })],
    [
      'started without a content block',
      event('content_block_start', { type: 'content_block_start', index: 0 }) + delta(0, {}),
    ],
    ['started with a block that has no type', start(0, {}) + delta(0, {})],
  ])('should leave a delta whose block never started without a block: %s', (label, sse) => {
    expect(parse(sse).at(-1)?.block).toBeUndefined();
  });

  test.each([
    ['an unknown event', { type: 'future', note: 'new' }],
    [
      'an error event',
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ],
  ])('should pass an unknown event through unchanged: %s', (label, data) => {
    // Assemble
    const sse = event(data.type, data);

    // Act and Assert
    expect(parse(sse)).toEqual([{ raw: sse, name: data.type, data, block: undefined }]);
  });

  test.each([
    ['a sentinel', 'event: message\ndata: [DONE]\n\n'],
    [
      'cut-off JSON',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0\n\n',
    ],
    // Data lines join with "\n" (the SSE spec), so these two are "1\n2", not the number 12.
    ['two lines that are JSON only if run together', 'event: message\ndata: 1\ndata: 2\n\n'],
  ])("should pass data that isn't JSON through unchanged: %s", (label, sse) => {
    expect(parse(sse)).toEqual([
      { raw: sse, name: sse.slice(7, sse.indexOf('\n')), data: undefined, block: undefined },
    ]);
  });

  test.each([
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('should read CRLF and CR line endings the same as LF: %s', (label, ending) => {
    // Assemble
    const lf = recorded('text-reply');
    const sse = lf.replaceAll('\n', ending);

    // Act
    const events = parse(sse);

    // Assert: the same events, each keeping the line endings it arrived with
    const fields = (all: StreamEvent[]) =>
      all.map(({ name, data, block }) => ({ name, data, block }));
    expect(fields(events)).toEqual(fields(parse(lf)));
    expect(events.map((e) => e.raw).join('')).toBe(sse);
  });

  test('should ignore comment lines and join several data lines', () => {
    // Assemble
    const sse =
      ': keep-alive\nevent: message_delta\n: another comment\nid: 7\n' +
      'data: {"type":"message_delta",\ndata\ndata:"usage":{"output_tokens":3}}\n\n';

    // Act and Assert: a data line may skip the space after its colon, a bare "data" adds an empty
    // line, and fields other than event and data are ignored
    expect(parse(sse)).toEqual([
      {
        raw: sse,
        name: 'message_delta',
        data: { type: 'message_delta', usage: { output_tokens: 3 } },
        block: undefined,
      },
    ]);
  });

  test.each([
    ['no line ending', 'event: message_stop\ndata: {"type":"message_stop"}'],
    ['one line ending', 'event: message_stop\ndata: {"type":"message_stop"}\n'],
  ])('should return a last event that has no blank line from end(): %s', (label, sse) => {
    // Assemble
    const parser = new StreamParser();

    // Act
    const pushed = parser.push(sse);
    const ended = parser.end();

    // Assert
    expect(pushed).toEqual([]);
    expect(ended).toEqual([
      { raw: sse, name: 'message_stop', data: { type: 'message_stop' }, block: undefined },
    ]);
  });

  test('should keep extra blank lines without making events', () => {
    // Assemble: blank lines, a data-less group and a comment between and after two pings
    const ping = event('ping', { type: 'ping' });
    const sse = `\n\n${ping}\nevent: ping\n\n${ping}: bye\n\n`;

    // Act
    const events = parse(sse);

    // Assert: leftovers fold into the next event, and what follows the last comes back alone
    expect(events.map((e) => e.name)).toEqual(['ping', 'ping', undefined]);
    expect(events.map((e) => e.raw)).toEqual([
      `\n\n${ping}`,
      `\nevent: ping\n\n${ping}`,
      ': bye\n\n',
    ]);
    expect(events.at(-1)?.data).toBeUndefined();
    expect(parse('')).toEqual([]);
  });
});

describe('formatEvent', () => {
  test('should write an event that reads back to the same name and data', () => {
    // Assemble: text with a line break and quotes, which JSON escapes onto one line
    const data = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'line one\nline "two"' },
    };

    // Act
    const sse = formatEvent('content_block_delta', data);

    // Assert
    expect(sse).toBe(`event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`);
    expect(parse(sse)).toEqual([{ raw: sse, name: 'content_block_delta', data, block: undefined }]);
  });
});
