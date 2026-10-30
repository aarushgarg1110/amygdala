import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { MAX_HOLDBACK_CHARS, StreamRestorer } from '../../src/engine/restore.ts';
import { TokenMap } from '../../src/engine/token-map.ts';
import { restoreText } from '../../src/engine/tokenize.ts';
import { cut, delta, parse, recorded, start, stop } from './sse.ts';

const KEY = Uint8Array.from(Array(32).keys());
const MAP = new TokenMap(KEY);
const issue = (id: string) => MAP.issue('pattern:customer-id', 'CUST', id, id);
const ONE = issue('CUST-0001');
const TWO = issue('CUST-0002');
const THREE = issue('CUST-0003');
// Shaped like a placeholder, but never issued by MAP.
const LOOKALIKE = 'CUST_aaaaaaaaaa';

/** A text block at `index` whose text arrives as `chunks`. */
const textBlock = (index: number, chunks: readonly string[]) =>
  start(index, { type: 'text', text: '' }) +
  chunks.map((text) => delta(index, { type: 'text_delta', text })).join('') +
  stop(index);

/** `sse` as the restorer sends it on. */
function restore(sse: string, map = MAP): string {
  const restorer = new StreamRestorer(map);
  return (
    parse(sse)
      .map((event) => restorer.push(event))
      .join('') + restorer.end()
  );
}

/** The text of every text_delta in `sse`, in order. */
const textDeltas = (sse: string) =>
  parse(sse).flatMap((event) => {
    const sent = (event.data as { delta?: { type: string; text?: string } } | undefined)?.delta;
    return sent?.type === 'text_delta' && sent.text !== undefined ? [sent.text] : [];
  });

describe('StreamRestorer', () => {
  test('should restore a whole placeholder inside one delta', () => {
    // Act
    const sent = textDeltas(restore(textBlock(0, [`Two customers: ${ONE} and more.`])));

    // Assert
    expect(sent).toEqual(['Two customers: CUST-0001 and more.']);
  });

  test.each([
    ['ending in a letter', ONE, 'CUST-0001'],
    ['ending in a base32 digit', THREE, 'CUST-0003'],
  ])(
    'should restore a placeholder split across two deltas at every position: %s',
    (label, placeholder, id) => {
      // Assemble
      const text = `Pay ${placeholder} now`;

      // Act: every split, checking the joined text and that no piece of a placeholder went out
      const wrong = [...Array(text.length + 1).keys()].filter((at) => {
        const sent = textDeltas(restore(textBlock(0, [text.slice(0, at), text.slice(at)])));
        return sent.join('') !== `Pay ${id} now` || sent.some((piece) => piece.includes('_'));
      });

      // Assert
      expect(wrong).toEqual([]);
    },
  );

  test('should restore placeholders when every character is its own delta', () => {
    // Act
    const sent = textDeltas(restore(textBlock(0, `${ONE}, ${THREE}.`.split(''))));

    // Assert
    expect(sent.join('')).toBe('CUST-0001, CUST-0003.');
    expect(sent.some((piece) => piece.includes('_'))).toBe(false);
  });

  test('should give the same text as restoring the joined stream, for any chunking', () => {
    // THREE and the second lookalike end in base32 digits, which also start an uppercase run.
    const piece = fc.constantFrom(
      ONE,
      TWO,
      THREE,
      LOOKALIKE,
      'CUST_aaaaaaaaa2',
      'USA',
      'CUST',
      '_',
      ' ',
      'ab',
      'X9',
      '\n',
      '"',
    );
    fc.assert(
      fc.property(
        fc.array(piece, { maxLength: 30 }),
        fc.array(fc.nat(), { maxLength: 20 }),
        (pieces, points) => {
          const text = pieces.join('');
          const chunks = cut(
            text,
            points.map((point) => point % (text.length + 1)),
          );
          return textDeltas(restore(textBlock(0, chunks))).join('') === restoreText(text, MAP);
        },
      ),
    );
  });

  test("should restore the recorded reply's three IDs across its real chunk boundaries", () => {
    // Assemble: the reply the model would have streamed had it seen placeholders. Swapping inside
    // each chunk keeps the recorded split "**C" + "UST-0001**" as "**C" + "UST_…**".
    const reply = recorded('read-tool-reply');
    const sse = [ONE, TWO, THREE].reduce(
      (text, placeholder, i) =>
        text.replaceAll(`UST-000${String(i + 1)}`, `UST${placeholder.slice('CUST'.length)}`),
      reply,
    );
    const input = textDeltas(sse);
    expect(input.some((t, i) => t.endsWith('**C') && input[i + 1]?.startsWith('UST_'))).toBe(true);

    // Act
    const sent = textDeltas(restore(sse));

    // Assert
    expect(sent.join('')).toBe(textDeltas(reply).join(''));
  });

  test('should leave text that only looks like a placeholder alone', () => {
    // Assemble
    expect(MAP.original(LOOKALIKE)).toBeUndefined();

    // Act
    const whole = textDeltas(restore(textBlock(0, [`see ${LOOKALIKE} here`])));
    const split = textDeltas(restore(textBlock(0, ['see CUST_aaa', 'aaaaaaa here'])));

    // Assert
    expect(whole.join('')).toBe(`see ${LOOKALIKE} here`);
    expect(split.join('')).toBe(`see ${LOOKALIKE} here`);
  });

  test("should send held text before the block's stop", () => {
    // Act
    const events = parse(restore(textBlock(0, ['see CUST_ggf'])));

    // Assert: one extra delta, unchanged, right before the stop
    expect(events.map((e) => e.name)).toEqual([
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
    ]);
    expect(textDeltas(events.map((e) => e.raw).join(''))).toEqual(['see ', 'CUST_ggf']);
  });

  test('should hold back a trailing uppercase run and send it with the next delta', () => {
    expect(textDeltas(restore(textBlock(0, ['in the USA', ' today'])))).toEqual([
      'in the ',
      'USA today',
    ]);
  });

  test.each([
    ['an 11-character run', 'x ABCDEFGHIJK', ['x A', 'BCDEFGHIJK']],
    [
      'a 20-character partial placeholder',
      'x ABCDEFGHIJ_ggfrgflzu',
      ['x ', 'ABCDEFGHIJ_ggfrgflzu'],
    ],
    ['one character more', 'x ABCDEFGHIJK_ggfrgflzu', ['x A', 'BCDEFGHIJK_ggfrgflzu']],
  ])('should hold back at most MAX_HOLDBACK_CHARS: %s', (label, text, sent) => {
    expect(MAX_HOLDBACK_CHARS).toBe(20);
    expect(textDeltas(restore(textBlock(0, [text])))).toEqual(sent);
  });

  test.each([
    ...['text-reply', 'read-tool-prompt', 'read-tool-result', 'thread-first', 'thread-delta'].map(
      (scenario) => [scenario, recorded(scenario)],
    ),
    ['a text block with no deltas', textBlock(0, [])],
  ])('should forward a delta with nothing to restore byte for byte: %s', (label, sse) => {
    expect(restore(sse)).toBe(sse);
  });

  test('should forward a fully held delta with empty text', () => {
    expect(textDeltas(restore(textBlock(0, ['A', 'B c'])))).toEqual(['', 'AB c']);
  });

  test('should leave thinking, signatures and tool arguments alone', () => {
    // Assemble
    const sse =
      start(0, { type: 'thinking', thinking: '', signature: '' }) +
      delta(0, { type: 'thinking_delta', thinking: `The file mentions ${ONE}.` }) +
      delta(0, { type: 'signature_delta', signature: 'c2lnbmVk' }) +
      stop(0) +
      start(1, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }) +
      delta(1, { type: 'input_json_delta', partial_json: `{"file_path": "/data/${ONE}.csv"}` }) +
      stop(1);

    // Act and Assert
    expect(restore(sse)).toBe(sse);
  });

  test('should keep hold-back separate per block', () => {
    // Act: block 0 ends on a partial placeholder that block 1's text would complete
    const sent = textDeltas(
      restore(textBlock(0, ['end CUST_ggf']) + textBlock(1, ['rgflzug more'])),
    );

    // Assert
    expect(sent).toEqual(['end ', 'CUST_ggf', 'rgflzug more']);
  });

  test('should send held text from end()', () => {
    // Act: the stream stops without closing its block
    const sent = textDeltas(
      restore(
        start(0, { type: 'text', text: '' }) + delta(0, { type: 'text_delta', text: 'x CUST_' }),
      ),
    );

    // Assert
    expect(sent).toEqual(['x ', 'CUST_']);
  });

  test('should escape a restored value so the event parses back to it', () => {
    // Assemble
    const map = new TokenMap(KEY);
    const original = 'a "quoted" \\ back\nslash';
    const placeholder = map.issue('pattern:note', 'NOTE', original, original);

    // Act
    const sent = textDeltas(restore(textBlock(0, [`see ${placeholder}`]), map));

    // Assert
    expect(sent).toEqual([`see ${original}`]);
  });
});
