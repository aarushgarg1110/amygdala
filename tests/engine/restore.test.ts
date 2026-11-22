import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { MAX_HOLDBACK_CHARS, restoreMessage, StreamRestorer } from '../../src/engine/restore.ts';
import { TokenMap } from '../../src/engine/token-map.ts';
import { restoreText } from '../../src/engine/tokenize.ts';
import { DEFAULT_TRUSTED_TOOLS, type TrustOptions } from '../../src/engine/trust.ts';
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

/** A `type` block at `index` calling `name`, its arguments arriving as `chunks`. */
const toolBlock = (
  index: number,
  name: string | undefined,
  chunks: readonly string[],
  type = 'tool_use',
) =>
  start(index, {
    type,
    id: `toolu_${String(index)}`,
    ...(name === undefined ? {} : { name }),
    input: {},
  }) +
  chunks.map((json) => delta(index, { type: 'input_json_delta', partial_json: json })).join('') +
  stop(index);

/** `sse` as the restorer sends it on. */
function restore(sse: string, map = MAP, options: TrustOptions = {}): string {
  const restorer = new StreamRestorer(map, options);
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

/** The partial_json of every input_json_delta in `sse`, in order. */
const argDeltas = (sse: string) =>
  parse(sse).flatMap((event) => {
    const sent = (event.data as { delta?: { type: string; partial_json?: string } } | undefined)
      ?.delta;
    return sent?.type === 'input_json_delta' && sent.partial_json !== undefined
      ? [sent.partial_json]
      : [];
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

  // read-tool-reply ends one text chunk in "**C" and read-tool-prompt one Bash chunk in "2>&1":
  // both are held and sent with the next chunk, so those two events are rewritten.
  test.each([
    ...['text-reply', 'read-tool-result', 'thread-first', 'thread-delta'].map((scenario) => [
      scenario,
      recorded(scenario),
    ]),
    ['a text block with no deltas', textBlock(0, [])],
  ])('should forward a delta with nothing to restore byte for byte: %s', (label, sse) => {
    expect(restore(sse)).toBe(sse);
  });

  test.each(
    [
      'text-reply',
      'read-tool-prompt',
      'read-tool-result',
      'read-tool-reply',
      'thread-first',
      'thread-delta',
    ].map((scenario) => [scenario, recorded(scenario)]),
  )('should keep every recorded stream’s events, text and arguments: %s', (label, sse) => {
    // Act
    const sent = restore(sse);

    // Assert
    expect(parse(sent).map((e) => e.name)).toEqual(parse(sse).map((e) => e.name));
    expect(textDeltas(sent).join('')).toBe(textDeltas(sse).join(''));
    expect(argDeltas(sent).join('')).toBe(argDeltas(sse).join(''));
  });

  test('should forward a fully held delta with empty text', () => {
    expect(textDeltas(restore(textBlock(0, ['A', 'B c'])))).toEqual(['', 'AB c']);
  });

  test('should leave thinking and signatures alone', () => {
    // Assemble
    const sse =
      start(0, { type: 'thinking', thinking: '', signature: '' }) +
      delta(0, { type: 'thinking_delta', thinking: `The file mentions ${ONE}.` }) +
      delta(0, { type: 'signature_delta', signature: 'c2lnbmVk' }) +
      stop(0);

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

describe('StreamRestorer: tool arguments', () => {
  test("should restore a placeholder in a trusted tool's arguments", () => {
    // Act
    const sent = argDeltas(restore(toolBlock(1, 'Read', [`{"file_path": "/data/${ONE}.csv"}`])));

    // Assert
    expect(sent).toEqual(['{"file_path": "/data/CUST-0001.csv"}']);
  });

  test.each([
    ['ending in a letter', ONE, 'CUST-0001'],
    ['ending in a base32 digit', THREE, 'CUST-0003'],
  ])(
    'should restore one split across argument chunks at every position: %s',
    (label, placeholder, id) => {
      // Assemble
      const args = JSON.stringify({ command: `grep ${placeholder} data.csv` });
      const want = JSON.stringify({ command: `grep ${id} data.csv` });

      // Act: every split, checking the joined arguments and that no piece of a placeholder went out
      const wrong = [...Array(args.length + 1).keys()].filter((at) => {
        const sent = argDeltas(restore(toolBlock(1, 'Bash', [args.slice(0, at), args.slice(at)])));
        return sent.join('') !== want || sent.some((piece) => piece.includes('_'));
      });

      // Assert
      expect(wrong).toEqual([]);
    },
  );

  test('should JSON-escape a restored value', () => {
    // Assemble
    const map = new TokenMap(KEY);
    const original = 'a "quoted" \\ back\nslash é';
    const placeholder = map.issue('pattern:note', 'NOTE', original, original);
    const args = JSON.stringify({ command: `echo ${placeholder}` });

    // Act
    const sent = argDeltas(restore(toolBlock(1, 'Bash', [args]), map)).join('');

    // Assert
    expect(JSON.parse(sent)).toEqual({ command: `echo ${original}` });
  });

  test('should give the restored arguments for any chunking', () => {
    const piece = fc.constantFrom(
      ONE,
      TWO,
      THREE,
      LOOKALIKE,
      'CUST_aaaaaaaaa2',
      'USA',
      'X9',
      '_',
      ' ',
      '"',
      '\\',
      '\n',
      'é',
    );
    const value = fc.array(piece, { maxLength: 12 }).map((pieces) => pieces.join(''));
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom('command', 'file_path', 'pattern'), value),
        fc.array(fc.nat(), { maxLength: 20 }),
        (input, points) => {
          const args = JSON.stringify(input);
          const chunks = cut(
            args,
            points.map((point) => point % (args.length + 1)),
          );
          const sent = argDeltas(restore(toolBlock(1, 'Bash', chunks))).join('');
          const want = Object.fromEntries(
            Object.entries(input).map(([field, text]) => [field, restoreText(text, MAP)]),
          );
          return isDeepStrictEqual(JSON.parse(sent), want);
        },
      ),
    );
  });

  test.each(['WebFetch', 'Artifact', 'mcp__claude_ai_Notion__notion-search', 'SomeNewTool'])(
    "should leave untrusted tools' arguments alone: %s",
    (name) => {
      // Assemble
      const sse = toolBlock(1, name, [`{"url": "https://example.com/${ONE}"}`]);

      // Act and Assert
      expect(restore(sse)).toBe(sse);
    },
  );

  test.each([
    ['a tool_use without a name', toolBlock(1, undefined, [`{"q": "${ONE}"}`])],
    [
      'a server_tool_use named like a trusted tool',
      toolBlock(1, 'Read', [`{"q": "${ONE}"}`], 'server_tool_use'),
    ],
  ])('should leave unnamed and server tool calls alone: %s', (label, sse) => {
    expect(restore(sse)).toBe(sse);
  });

  test('should trust MCP tools only by a configured prefix', () => {
    // Assemble
    const options = { trustedPrefixes: ['mcp__plugin_ops_ops__'] };
    const args = [`{"key": "${ONE}"}`];
    const lookalike = toolBlock(1, 'mcp__plugin_ops_opsx__fetch', args);
    const unconfigured = toolBlock(1, 'mcp__plugin_ops_ops__fetch', args);

    // Act
    const trusted = argDeltas(
      restore(toolBlock(1, 'mcp__plugin_ops_ops__fetch', args), MAP, options),
    );

    // Assert
    expect(trusted).toEqual(['{"key": "CUST-0001"}']);
    expect(restore(lookalike, MAP, options)).toBe(lookalike);
    expect(restore(unconfigured)).toBe(unconfigured);
  });

  test("should send held arguments before the block's stop", () => {
    // Act
    const events = parse(restore(toolBlock(1, 'Bash', ['{"command": "echo CUST_ggf'])));

    // Assert: one extra input_json_delta, unchanged, right before the stop
    expect(events.map((e) => e.name)).toEqual([
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
    ]);
    expect(argDeltas(events.map((e) => e.raw).join(''))).toEqual([
      '{"command": "echo ',
      'CUST_ggf',
    ]);
  });

  test('should restore text and arguments in one reply by their own rules', () => {
    // Assemble: the text and two tool blocks interleave, each with a placeholder split in two
    const map = new TokenMap(KEY);
    const original = 'say "hi"';
    const note = map.issue('pattern:note', 'NOTE', original, original);
    const tool = (index: number) => ({
      type: 'tool_use',
      id: `toolu_${String(index)}`,
      name: 'Bash',
      input: {},
    });
    const args = (index: number, json: string) =>
      delta(index, { type: 'input_json_delta', partial_json: json });
    const sse =
      start(0, { type: 'text', text: '' }) +
      start(1, tool(1)) +
      start(2, tool(2)) +
      delta(0, { type: 'text_delta', text: `About ${note.slice(0, 7)}` }) +
      args(1, `{"command": "echo ${note.slice(0, 9)}`) +
      args(2, `{"command": "cat ${note.slice(0, 3)}`) +
      delta(0, { type: 'text_delta', text: `${note.slice(7)}.` }) +
      args(1, `${note.slice(9)}"}`) +
      args(2, `${note.slice(3)}"}`) +
      stop(0) +
      stop(1) +
      stop(2);

    // Act
    const events = parse(restore(sse, map));
    const argsOf = (index: number) =>
      argDeltas(
        events
          .filter((e) => (e.data as { index?: number } | undefined)?.index === index)
          .map((e) => e.raw)
          .join(''),
      ).join('');

    // Assert: text is restored raw, arguments JSON-escaped, and no block's hold-back joins another's
    expect(textDeltas(events.map((e) => e.raw).join('')).join('')).toBe(`About ${original}.`);
    expect(JSON.parse(argsOf(1))).toEqual({ command: `echo ${original}` });
    expect(JSON.parse(argsOf(2))).toEqual({ command: `cat ${original}` });
  });

  test.each([
    ['the shortest prefix', 'AB'],
    ['the longest prefix', 'ABCDEFGHIJ'],
  ])('should restore placeholders with %s in arguments', (label, prefix) => {
    // Assemble
    const map = new TokenMap(KEY);
    const placeholder = map.issue('pattern:edge', prefix, 'X-1', 'X-1');
    const args = JSON.stringify({ pattern: placeholder });

    // Act: split one character before the end of the placeholder
    const sent = argDeltas(restore(toolBlock(1, 'Grep', [args.slice(0, -3), args.slice(-3)]), map));

    // Assert
    expect(sent.join('')).toBe(JSON.stringify({ pattern: 'X-1' }));
  });

  test('should use a custom trusted list instead of the default', () => {
    // Assemble
    const options = { trustedTools: ['Fetcher'] };
    const read = toolBlock(1, 'Read', [`{"file_path": "${ONE}"}`]);

    // Act
    const custom = argDeltas(restore(toolBlock(1, 'Fetcher', [`{"id": "${ONE}"}`]), MAP, options));

    // Assert
    expect(custom).toEqual(['{"id": "CUST-0001"}']);
    expect(restore(read, MAP, options)).toBe(read);
  });

  test('should send held arguments from end()', () => {
    // Act: the stream stops without closing its block
    const sent = argDeltas(
      restore(
        start(1, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }) +
          delta(1, { type: 'input_json_delta', partial_json: '{"command": "x CUST_' }),
      ),
    );

    // Assert
    expect(sent).toEqual(['{"command": "x ', 'CUST_']);
  });

  test.each([
    [
      'a text_delta without text',
      textBlock(0, []).replace(
        'event: content_block_stop',
        `${delta(0, { type: 'text_delta' })}event: content_block_stop`,
      ),
    ],
    [
      'an input_json_delta whose partial_json is a number',
      toolBlock(1, 'Bash', []).replace(
        'event: content_block_stop',
        `${delta(1, { type: 'input_json_delta', partial_json: 7 })}event: content_block_stop`,
      ),
    ],
  ])('should forward a delta whose content is not a string unchanged: %s', (label, sse) => {
    expect(restore(sse)).toBe(sse);
  });

  test('should leave an unissued lookalike in arguments alone', () => {
    // Assemble
    const args = `{"file_path": "/data/${LOOKALIKE}.csv"}`;

    // Act
    const whole = argDeltas(restore(toolBlock(1, 'Read', [args])));
    const split = argDeltas(restore(toolBlock(1, 'Read', [args.slice(0, 25), args.slice(25)])));

    // Assert
    expect(whole.join('')).toBe(args);
    expect(split.join('')).toBe(args);
  });

  test.each([
    ['not starting with mcp__', 'plugin_ops_ops__'],
    ['not ending with __', 'mcp__ops'],
    ['nothing between the underscores', 'mcp____'],
    ['a claude.ai connector', 'mcp__claude_ai_Notion__'],
  ])('should refuse an MCP prefix that could trust the wrong tools: %s', (label, prefix) => {
    expect(() => new StreamRestorer(MAP, { trustedPrefixes: [prefix] })).toThrow(prefix);
  });

  test('should export the decided default trusted list', () => {
    expect([...DEFAULT_TRUSTED_TOOLS].sort()).toEqual(
      [
        'Read',
        'Write',
        'Edit',
        'NotebookEdit',
        'Grep',
        'Glob',
        'Bash',
        'Monitor',
        'TaskStop',
        'Agent',
        'Workflow',
        'Skill',
        'ToolSearch',
        'AskUserQuestion',
        'TodoWrite',
        'EnterPlanMode',
        'ExitPlanMode',
        'ScheduleWakeup',
        'EnterWorktree',
        'ExitWorktree',
      ].sort(),
    );
  });
});

/** A whole reply with R5's top-level keys (its non-streaming side calls), holding `content`. */
const reply = (content: readonly unknown[]) =>
  JSON.stringify({
    model: 'claude-haiku-5-5',
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    content,
    container: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 12, output_tokens: 7 },
    diagnostics: null,
    context_management: null,
  });

/** A `type` block calling `name` with `input`. */
const tool = (name: string | undefined, input: unknown, type = 'tool_use') => ({
  type,
  id: 'toolu_01',
  ...(name === undefined ? {} : { name }),
  input,
});

const contentOf = (body: string) =>
  (JSON.parse(body) as { content: { text?: string; input?: unknown }[] }).content;

/** The oracle: every string in `value` restored, object keys included. */
const restoreAll = (value: unknown): unknown => {
  if (typeof value === 'string') return restoreText(value, MAP);
  if (Array.isArray(value)) return value.map(restoreAll);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [restoreText(key, MAP), restoreAll(item)]),
    );
  }
  return value;
};

describe('StreamRestorer: hold-back', () => {
  test.todo('should pass every recording through byte for byte when nothing is issued');
  test.todo('should send at once an end no issued prefix could start');
  test.todo('should hold an end that could still become an issued placeholder');
  test.todo('should never send a piece of an issued placeholder early, wherever it is split');
  test.todo('should send the capitals before a placeholder at once');
  test.todo('should hold the longest possible start when one prefix ends another');
  test.todo('should send a held end that never completes unchanged');
  test.todo("should still hold a recording's end that could start an issued prefix");
});

describe('restoreMessage', () => {
  test("should restore a placeholder in a reply's text", () => {
    // Assemble
    const body = reply([{ type: 'text', text: `Replied OK to ${ONE}.` }]);

    // Act
    const sent = restoreMessage(body, MAP);

    // Assert: the text is restored and every other key is as it was
    expect(contentOf(sent)).toEqual([{ type: 'text', text: 'Replied OK to CUST-0001.' }]);
    expect({ ...(JSON.parse(sent) as object), content: [] }).toEqual({
      ...(JSON.parse(body) as object),
      content: [],
    });
  });

  test('should leave every field outside content alone', () => {
    // Assemble: a refusal-style explanation holding a placeholder, next to a text that changes
    const body = JSON.stringify({
      ...(JSON.parse(reply([{ type: 'text', text: ONE }])) as object),
      stop_details: { type: 'refusal', explanation: `About ${ONE}` },
    });

    // Act
    const sent = JSON.parse(restoreMessage(body, MAP)) as { stop_details: unknown };

    // Assert
    expect(sent.stop_details).toEqual({ type: 'refusal', explanation: `About ${ONE}` });
    expect(contentOf(JSON.stringify(sent))).toEqual([{ type: 'text', text: 'CUST-0001' }]);
  });

  test('should leave thinking alone', () => {
    // Assemble
    const thinking = { type: 'thinking', thinking: `They mean ${ONE}.`, signature: 'c2lnbmVk' };

    // Act
    const sent = contentOf(restoreMessage(reply([thinking, { type: 'text', text: ONE }]), MAP));

    // Assert
    expect(sent).toEqual([thinking, { type: 'text', text: 'CUST-0001' }]);
  });

  test("should restore every string in a trusted tool's nested input", () => {
    // Assemble
    const map = new TokenMap(KEY);
    const original = 'a "quoted" \\ back\nslash';
    const note = map.issue('pattern:note', 'NOTE', original, original);
    const input = {
      command: `echo ${note}`,
      args: [note, { deep: [`x ${note}`] }],
      n: 3,
      ok: true,
    };

    // Act
    const sent = contentOf(restoreMessage(reply([tool('Bash', input)]), map));

    // Assert
    expect(sent[0]?.input).toEqual({
      command: `echo ${original}`,
      args: [original, { deep: [`x ${original}`] }],
      n: 3,
      ok: true,
    });
  });

  test.each([
    ['WebFetch', tool('WebFetch', { url: `https://example.com/${ONE}` })],
    ['an unknown tool', tool('SomeNewTool', { id: ONE })],
    ['a tool_use without a name', tool(undefined, { id: ONE })],
    ['a server_tool_use named Read', tool('Read', { file_path: ONE }, 'server_tool_use')],
  ])('should leave untrusted, unnamed and server tool calls alone: %s', (label, block) => {
    // Assemble
    const body = reply([block]);

    // Act and Assert
    expect(restoreMessage(body, MAP)).toBe(body);
  });

  test('should trust MCP tools only by a configured prefix', () => {
    // Assemble
    const options = { trustedPrefixes: ['mcp__plugin_ops_ops__'] };
    const trusted = reply([tool('mcp__plugin_ops_ops__fetch', { key: ONE })]);
    const lookalike = reply([tool('mcp__plugin_ops_opsx__fetch', { key: ONE })]);

    // Act
    const sent = contentOf(restoreMessage(trusted, MAP, options));

    // Assert: the same rule as the streaming path, refusals included
    expect(sent[0]?.input).toEqual({ key: 'CUST-0001' });
    expect(restoreMessage(lookalike, MAP, options)).toBe(lookalike);
    expect(restoreMessage(trusted, MAP)).toBe(trusted);
    expect(() =>
      restoreMessage(trusted, MAP, { trustedPrefixes: ['mcp__claude_ai_Notion__'] }),
    ).toThrow('mcp__claude_ai_Notion__');
  });

  test('should use a custom trusted list instead of the default', () => {
    // Assemble
    const options = { trustedTools: ['Fetcher'] };
    const read = reply([tool('Read', { file_path: ONE })]);

    // Act
    const sent = contentOf(restoreMessage(reply([tool('Fetcher', { id: ONE })]), MAP, options));

    // Assert
    expect(sent[0]?.input).toEqual({ id: 'CUST-0001' });
    expect(restoreMessage(read, MAP, options)).toBe(read);
  });

  test('should restore a placeholder used as an object key', () => {
    // Act
    const sent = contentOf(
      restoreMessage(reply([tool('Write', { files: { [ONE]: 'pro', other: TWO } })]), MAP),
    );

    // Assert
    expect(sent[0]?.input).toEqual({ files: { 'CUST-0001': 'pro', other: 'CUST-0002' } });
  });

  test.each([
    [
      'padded JSON with plain text',
      '{ "type": "message",  "content": [ { "type": "text", "text": "All clear." } ] }',
    ],
    [
      'a reply with only thinking',
      reply([{ type: 'thinking', thinking: `About ${ONE}`, signature: 'c2ln' }]),
    ],
    ['an empty content array', reply([])],
  ])('should return the exact bytes when nothing is restored: %s', (label, body) => {
    expect(restoreMessage(body, MAP)).toBe(body);
  });

  test.each([
    ['not JSON', `event: message_start\ndata: {"x": "${ONE}"}`],
    ['no content array', `{"type": "message", "content": "${ONE}"}`],
    ['an error body', `{"type":"error","error":{"type":"overloaded_error","message":"${ONE}"}}`],
    ['null', 'null'],
    ['an array', `["${ONE}"]`],
    ['content items that are not blocks', `{"content": ["${ONE}", 1, null]}`],
  ])('should return a body that is not a reply unchanged: %s', (label, body) => {
    expect(restoreMessage(body, MAP)).toBe(body);
  });

  test('should leave an unissued lookalike alone', () => {
    // Assemble
    const body = reply([
      { type: 'text', text: `see ${LOOKALIKE}` },
      tool('Read', { file_path: LOOKALIKE, [LOOKALIKE]: [LOOKALIKE] }),
    ]);

    // Act and Assert
    expect(restoreMessage(body, MAP)).toBe(body);
  });

  test('should give the restored input for any input', () => {
    const piece = fc.constantFrom(
      ONE,
      TWO,
      THREE,
      LOOKALIKE,
      'CUST_aaaaaaaaa2',
      'USA',
      '"',
      '\\',
      '\n',
      ' ',
      'é',
    );
    const text = fc.array(piece, { maxLength: 8 }).map((pieces) => pieces.join(''));
    const key = fc.constantFrom('command', 'path', ONE, LOOKALIKE);
    const { value } = fc.letrec((tie) => ({
      value: fc.oneof(
        { depthSize: 'small' },
        text,
        fc.integer(),
        fc.array(tie('value'), { maxLength: 3 }),
        fc.dictionary(key, tie('value'), { maxKeys: 3 }),
      ),
    }));
    fc.assert(
      fc.property(fc.dictionary(key, value, { maxKeys: 3 }), (input) => {
        const sent = contentOf(restoreMessage(reply([tool('Bash', input)]), MAP));
        return isDeepStrictEqual(sent[0]?.input, restoreAll(input));
      }),
    );
  });
});
