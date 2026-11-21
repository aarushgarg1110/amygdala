import { Buffer } from 'node:buffer';
import { describe, expect, test } from 'vitest';
import { buildDetectors } from '../../../src/engine/detector.ts';
import {
  createOwnKeyDetector,
  OWN_KEY_DETECTOR,
  ownKeyEncodings,
} from '../../../src/engine/detectors/own-key.ts';
import { placeholderFor } from '../../../src/engine/placeholder.ts';
import { RequestTokenizer } from '../../../src/engine/request.ts';
import { TokenMap } from '../../../src/engine/token-map.ts';
import { tokenizeText } from '../../../src/engine/tokenize.ts';

// base64 of the first six bytes is "++++////", so URL-encoding and JSON-escaping both change it.
const KEY = Uint8Array.from([0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff, ...Array(26).keys()]);
const OTHER = Uint8Array.from(Array(32).keys());
const HEX = Buffer.from(KEY).toString('hex');
const B64 = Buffer.from(KEY).toString('base64');
const B64URL = Buffer.from(KEY).toString('base64url');
const PLACEHOLDER = placeholderFor(KEY, OWN_KEY_DETECTOR, 'KEY', 'own-key');
const detector = createOwnKeyDetector(KEY);

/** The text of every span the detector finds in `text`. */
const found = (text: string) => detector.find(text).map((span) => text.slice(span.start, span.end));

describe('own-key detector', () => {
  test('should count the key found in a request', () => {
    // Assemble
    const tokenizer = new RequestTokenizer([detector], new TokenMap(KEY));
    const body = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `key: ${HEX}` }],
        },
      ],
    };

    // Act
    const result = tokenizer.tokenize(body);

    // Assert
    expect(result.hits).toEqual({ [OWN_KEY_DETECTOR]: 1 });
    expect(JSON.stringify(result.body)).not.toContain(HEX);
  });

  test.each([
    ['lowercase', HEX],
    ['uppercase', HEX.toUpperCase()],
    [
      'mixed case',
      HEX.replace(/[a-f]/g, (c, offset: number) => (offset % 2 === 0 ? c : c.toUpperCase())),
    ],
  ])('should find hex in any letter case: %s', (label, form) => {
    expect(found(`x ${form} y`)).toEqual([form]);
  });

  test.each([
    ['base64, padded', B64],
    ['base64, unpadded', B64.replace(/=+$/, '')],
    ['base64url, unpadded', B64URL],
    ['base64url, padded', `${B64URL}=`],
  ])('should find base64 and base64url, padded and unpadded: %s', (label, form) => {
    expect(found(`k=${form};`)).toEqual([form]);
  });

  test.each([
    ['upper-case escapes', encodeURIComponent(B64)],
    [
      'lower-case escapes',
      encodeURIComponent(B64).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    ],
  ])('should find URL-encoded base64 in either percent case: %s', (label, form) => {
    // Assemble: the key was chosen so its base64 has every character URL-encoding changes
    expect(B64).toMatch(/^\+{4}\/{4}.*=$/);

    // Act and Assert
    expect(found(`?token=${form}&x=1`)).toEqual([form]);
  });

  test('should find JSON-escaped base64', () => {
    const form = B64.replaceAll('/', '\\/');
    expect(found(`{"k":"${form}"}`)).toEqual([form]);
  });

  test('should cover exactly the key inside other text', () => {
    expect(detector.find(`token=${HEX}&x=1`)).toEqual([
      { start: 6, end: 6 + HEX.length, canonical: 'own-key' },
    ]);
  });

  test('should give every occurrence one placeholder', () => {
    // Act
    const result = tokenizeText(`${HEX} and ${B64}`, [detector], new TokenMap(KEY));

    // Assert
    expect(result.text).toBe(`${PLACEHOLDER} and ${PLACEHOLDER}`);
    expect(result.hits).toEqual({ [OWN_KEY_DETECTOR]: 2 });
  });

  test.each([
    ...ownKeyEncodings(OTHER).map((form) => [`another key, ${form.slice(0, 8)}…`, form]),
    ['the hex with its first character missing', HEX.slice(1)],
    ['the base64 with one character missing', B64.slice(0, 20) + B64.slice(21)],
  ])('should not find another key or a partial key: %s', (label, text) => {
    expect(found(text)).toEqual([]);
  });

  test.each([0, 16, 31])('should refuse a key shorter than 32 bytes: %i bytes', (length) => {
    expect(() => createOwnKeyDetector(new Uint8Array(length))).toThrow('at least 32 bytes');
  });

  test("should still count the key inside another detector's longer match", () => {
    // Assemble: a 64+ hex-character detector claims the key and the bytes after it
    const detectors = [
      detector,
      ...buildDetectors([
        { kind: 'pattern', name: 'long-hex', prefix: 'HEX', pattern: '[0-9a-f]{64,}' },
      ]),
    ];

    // Act
    const result = tokenizeText(`blob ${HEX}00ff end`, detectors, new TokenMap(KEY));

    // Assert: one placeholder for the whole match, and the key is still counted
    expect(result.text).toBe(
      `blob ${placeholderFor(KEY, 'pattern:long-hex', 'HEX', `${HEX}00ff`)} end`,
    );
    expect(result.hits).toEqual({ [OWN_KEY_DETECTOR]: 1, 'pattern:long-hex': 1 });
  });

  test('should derive the placeholder from a constant, not from the key', () => {
    // Act
    const map = new TokenMap(KEY);
    const placeholders = ownKeyEncodings(KEY).map(
      (form) => tokenizeText(form, [detector], map).text,
    );

    // Assert: seven forms, one placeholder
    expect(ownKeyEncodings(KEY)).toHaveLength(7);
    expect(new Set(placeholders)).toEqual(new Set([PLACEHOLDER]));
  });
});
