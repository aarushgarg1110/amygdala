import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { buildDetectors, type Detector } from '../../src/engine/detector.ts';
import { KeyCollisionError, RequestTokenizer } from '../../src/engine/request.ts';
import { TokenMap } from '../../src/engine/token-map.ts';
import { restoreText } from '../../src/engine/tokenize.ts';

const KEY = Uint8Array.from(Array(32).keys());
const ID = /CUST-\d{4}/g;
const DETECTORS = buildDetectors([
  { kind: 'pattern', name: 'customer-id', prefix: 'CUST', pattern: String.raw`CUST-\d{4,}` },
]);

const THINKING = {
  type: 'thinking',
  thinking: 'The user mentions CUST-0001.',
  signature: 'c2lnbmVkIGJ5IHRoZSBBUEk=',
};
const REDACTED = { type: 'redacted_thinking', data: 'CUST-0001 opaque bytes' };

/** A synthetic request in the shape Claude Code sends (seen in R1), with IDs in every place. */
const REQUEST = {
  model: 'claude-haiku-5-5',
  stream: true,
  max_tokens: 1024,
  temperature: null,
  system: [
    { type: 'text', text: 'Customer CUST-0001 is VIP.', cache_control: { type: 'ephemeral' } },
  ],
  tools: [
    {
      name: 'lookup',
      description: 'Look up IDs such as CUST-0002',
      input_schema: { type: 'object', properties: { id: { type: 'string' } } },
    },
  ],
  messages: [
    { role: 'user', content: 'Check CUST-0001 please' },
    {
      role: 'assistant',
      content: [
        THINKING,
        REDACTED,
        { type: 'text', text: 'Looking up CUST-0001.' },
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'lookup',
          input: { id: 'CUST-0001', related: ['CUST-0002', { note: 'see CUST-0003' }] },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'CUST-0001: active' },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_02',
          content: [{ type: 'text', text: 'CUST-0002: closed' }],
        },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CUST-0001' } },
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: 'CUST-0001' },
        },
      ],
    },
  ],
  diagnostics: { note: 'CUST-0004 in a field amygdala has never seen' },
};

/** Restores every string and key, mirroring the walk. */
function restoreAll(value: unknown, map: TokenMap): unknown {
  if (typeof value === 'string') return restoreText(value, map);
  if (Array.isArray(value)) return value.map((item) => restoreAll(item, map));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [restoreText(key, map), restoreAll(item, map)]),
  );
}

function countingDetector(): { detector: Detector; calls: () => number } {
  let calls = 0;
  const detector: Detector = {
    name: 'pattern:counter',
    prefix: 'CNT',
    find: () => {
      calls++;
      return [];
    },
  };
  return { detector, calls: () => calls };
}

describe('RequestTokenizer', () => {
  test('should replace every protected value in every scanned place', () => {
    // Assemble
    const map = new TokenMap(KEY);

    // Act
    const { body } = new RequestTokenizer(DETECTORS, map).tokenize(REQUEST);

    // Assert: only the three untouched kinds still hold an ID (thinking, image, PDF; the
    // redacted block's data starts with one too), and restoring gives the original back
    expect(JSON.stringify(body).match(ID)).toEqual([
      'CUST-0001',
      'CUST-0001',
      'CUST-0001',
      'CUST-0001',
    ]);
    expect(restoreAll(body, map)).toEqual(REQUEST);
  });

  test('should leave a thinking block untouched', () => {
    const { body } = new RequestTokenizer(DETECTORS, new TokenMap(KEY)).tokenize(REQUEST);
    expect((body as typeof REQUEST).messages[1]?.content[0]).toBe(THINKING);
  });

  test('should leave a redacted_thinking block untouched', () => {
    const { body } = new RequestTokenizer(DETECTORS, new TokenMap(KEY)).tokenize(REQUEST);
    expect((body as typeof REQUEST).messages[1]?.content[1]).toBe(REDACTED);
  });

  test('should leave a signature untouched wherever it is', () => {
    // Assemble: a signature outside any thinking block
    const block = { type: 'text', text: 'CUST-0001', signature: 'CUST-0001' };

    // Act
    const { body } = new RequestTokenizer(DETECTORS, new TokenMap(KEY)).tokenize(block);

    // Assert
    expect(body).toEqual({ type: 'text', text: 'CUST_ggfrgflzug', signature: 'CUST-0001' });
  });

  test('should leave base64 data untouched and count images and documents', () => {
    // Act
    const result = new RequestTokenizer(DETECTORS, new TokenMap(KEY)).tokenize(REQUEST);

    // Assert
    expect([result.images, result.documents]).toEqual([1, 1]);
    const sources = (result.body as typeof REQUEST).messages[2]?.content.slice(2);
    expect(JSON.stringify(sources)).toContain('"data":"CUST-0001"');
  });

  test('should count a base64 source without a media type as a document', () => {
    const result = new RequestTokenizer(DETECTORS, new TokenMap(KEY)).tokenize({
      type: 'base64',
      data: 'AAAA',
    });
    expect([result.images, result.documents]).toEqual([0, 1]);
  });

  test('should tokenize object keys', () => {
    const { body } = new RequestTokenizer(DETECTORS, new TokenMap(KEY)).tokenize({
      input: { 'CUST-0001': 'owner' },
    });
    expect(body).toEqual({ input: { CUST_ggfrgflzug: 'owner' } });
  });

  test('should throw KeyCollisionError when two keys become one', () => {
    // Assemble: under ignoreCase both spellings get one placeholder
    const detectors = buildDetectors([
      {
        kind: 'pattern',
        name: 'customer-id',
        prefix: 'CUST',
        pattern: String.raw`CUST-\d{4,}`,
        ignoreCase: true,
      },
    ]);
    const tokenizer = new RequestTokenizer(detectors, new TokenMap(KEY));
    const body = { 'cust-0001': 1, 'CUST-0001': 2 };

    // Act and Assert: fails closed, and the message names only the placeholder
    expect(() => tokenizer.tokenize(body)).toThrow(KeyCollisionError);
    expect(() => tokenizer.tokenize(body)).toThrow(
      /^two keys of one object both became CUST_ggfrgflzug$/,
    );
  });

  test('should keep a __proto__ key as an ordinary key', () => {
    // Assemble: JSON.parse makes "__proto__" an own key, as a request body would
    const input = JSON.parse('{"__proto__": {"owner": "CUST-0001"}, "a": 1}') as object;

    // Act
    const { body } = new RequestTokenizer(DETECTORS, new TokenMap(KEY)).tokenize(input);

    // Assert
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
    expect(Object.keys(body as object)).toEqual(['__proto__', 'a']);
    expect(JSON.stringify(body)).toBe('{"__proto__":{"owner":"CUST_ggfrgflzug"},"a":1}');
  });

  test('should leave numbers, booleans and null unchanged', () => {
    const scalars = [0, -1.5, true, false, null];
    expect(new RequestTokenizer(DETECTORS, new TokenMap(KEY)).tokenize(scalars).body).toEqual(
      scalars,
    );
  });

  test('should scan fields it does not know about', () => {
    const { body } = new RequestTokenizer(DETECTORS, new TokenMap(KEY)).tokenize(REQUEST);
    expect(JSON.stringify((body as typeof REQUEST).diagnostics)).not.toContain('CUST-0004');
  });

  test('should not call detectors again for strings it has seen', () => {
    // Assemble
    const { detector, calls } = countingDetector();
    const tokenizer = new RequestTokenizer([detector], new TokenMap(KEY));
    const first = tokenizer.tokenize(REQUEST);
    const afterFirst = calls();

    // Act
    const second = tokenizer.tokenize(REQUEST);

    // Assert
    expect(afterFirst).toBeGreaterThan(0);
    expect(calls()).toBe(afterFirst);
    expect(second.hits).toEqual(first.hits);
  });

  test('should evict the least recently used string past the cache limit', () => {
    // Assemble: room for two strings
    const { detector, calls } = countingDetector();
    const tokenizer = new RequestTokenizer([detector], new TokenMap(KEY), 2);
    tokenizer.tokenize('a');
    tokenizer.tokenize('b');
    tokenizer.tokenize('a'); // "a" is now the most recently used

    // Act: "c" pushes out the least recently used, which is "b"
    tokenizer.tokenize('c');
    const before = calls();
    tokenizer.tokenize('a');
    const afterA = calls();
    tokenizer.tokenize('b');

    // Assert
    expect(afterA).toBe(before);
    expect(calls()).toBe(before + 1);
  });

  test('should sum hits across strings', () => {
    // 10 IDs outside the untouched kinds, plus none in keys
    const { hits } = new RequestTokenizer(DETECTORS, new TokenMap(KEY)).tokenize(REQUEST);
    expect(hits).toEqual({ 'pattern:customer-id': 10 });
  });

  const RESERVED = ['type', 'signature', 'data'];
  const jsonWithIds = fc.letrec((tie) => ({
    value: fc.oneof(
      { depthSize: 'small' },
      fc.string(),
      fc.stringMatching(/^CUST-\d{4}$/),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.array(tie('value'), { maxLength: 4 }),
      fc.dictionary(
        fc
          .oneof(fc.string(), fc.stringMatching(/^CUST-\d{4}$/))
          .filter((k) => !RESERVED.includes(k)),
        tie('value'),
        { maxKeys: 4 },
      ),
    ),
  })).value;

  test('should give the original back after restoring every string (property)', () => {
    fc.assert(
      fc.property(jsonWithIds, (value) => {
        const map = new TokenMap(KEY);
        const { body } = new RequestTokenizer(DETECTORS, map).tokenize(value);
        expect(restoreAll(body, map)).toEqual(value);
      }),
    );
  });

  test('should leave nothing any detector can find (property)', () => {
    fc.assert(
      fc.property(jsonWithIds, (value) => {
        const { body } = new RequestTokenizer(DETECTORS, new TokenMap(KEY)).tokenize(value);
        return DETECTORS.every((detector) => detector.find(JSON.stringify(body)).length === 0);
      }),
    );
  });
});
