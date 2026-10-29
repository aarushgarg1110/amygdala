import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  REMINDER_STAND_IN,
  SYSTEM_STAND_IN,
  TOOL_STAND_IN,
  scrubRequest,
  scrubStream,
  type Markers,
} from '../scripts/scrub-fixture.ts';
import { buildDetectors } from '../src/engine/detector.ts';
import { RequestTokenizer } from '../src/engine/request.ts';
import { TokenMap } from '../src/engine/token-map.ts';

const ROOT = 'tests/fixtures/claude-code';
const SCENARIOS = readdirSync(ROOT);
// Anthropic's prompt text is replaced by stand-ins; anything this long in system or tools means a
// recording slipped through unscrubbed.
const MAX_PROMPT_TEXT = 200;
// Local only: a maintainer's own markers (company, paths), never committed and unset in CI.
const FORBIDDEN = (process.env.AMYGDALA_FIXTURE_FORBIDDEN ?? '')
  .split(',')
  .filter((marker) => marker !== '');

const request = (scenario: string) =>
  JSON.parse(readFileSync(join(ROOT, scenario, 'request.json'), 'utf8')) as Record<string, unknown>;
const stream = (scenario: string) => readFileSync(join(ROOT, scenario, 'response.sse'), 'utf8');

// The model's output arrives in chunks that can split a path ("/Users" + "/alice/x"), so the guard
// also reads each content block's text joined back together.
function blockText(sse: string): string {
  const blocks = new Map<string, string>();
  for (const line of sse.split('\n').filter((l) => l.startsWith('data: '))) {
    const event = JSON.parse(line.slice('data: '.length)) as {
      type: string;
      index: number;
      delta?: Record<string, unknown>;
    };
    if (event.type !== 'content_block_delta' || event.delta === undefined) continue;
    for (const [field, value] of Object.entries(event.delta)) {
      if (field === 'type' || typeof value !== 'string') continue;
      const key = `${String(event.index)}:${field}`;
      blocks.set(key, (blocks.get(key) ?? '') + value);
    }
  }
  return [...blocks.values()].join('\n');
}

const everything = (scenario: string) =>
  [
    readFileSync(join(ROOT, scenario, 'request.json'), 'utf8'),
    stream(scenario),
    blockText(stream(scenario)),
  ].join('\n');

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
}

describe('recorded Claude Code fixtures', () => {
  test('should cover the recorded scenarios', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(6);
  });

  test.each(SCENARIOS)(
    'should parse every request as JSON and every response as a stream ending in message_stop: %s',
    (scenario) => {
      // Act
      const events = stream(scenario)
        .split('\n')
        .filter((line) => line.startsWith('event: '))
        .map((line) => line.slice('event: '.length).trim());

      // Assert
      expect(request(scenario)).toHaveProperty('messages');
      expect(events.at(0)).toBe('message_start');
      expect(events.at(-1)).toBe('message_stop');
    },
  );

  test.each(SCENARIOS)('should contain no home directory paths: %s', (scenario) => {
    const text = everything(scenario);
    expect(text).not.toMatch(/\/Users\//);
    expect(text.match(/\/home\/[^/\s"]+/g) ?? []).toEqual(
      (text.match(/\/home\/[^/\s"]+/g) ?? []).map(() => '/home/dev'),
    );
  });

  test.each(SCENARIOS)('should contain no email address outside example.com: %s', (scenario) => {
    const emails = everything(scenario).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [];
    for (const email of emails) expect(email).toMatch(/@example\.com$/);
  });

  test.each(SCENARIOS)('should keep system and tool text under the length cap: %s', (scenario) => {
    // Assemble
    const body = request(scenario);
    const systemMessages = (body.messages as { role: string }[]).filter((m) => m.role === 'system');

    // Act
    const promptText = [
      ...strings(body.system),
      ...strings(body.tools),
      ...strings(systemMessages),
    ];

    // Assert
    for (const text of promptText) expect(text.length).toBeLessThanOrEqual(MAX_PROMPT_TEXT);
  });

  test.runIf(FORBIDDEN.length > 0).each(SCENARIOS)(
    'should contain none of the markers in AMYGDALA_FIXTURE_FORBIDDEN: %s',
    (scenario) => {
      const text = everything(scenario).toLowerCase();
      for (const marker of FORBIDDEN) expect(text).not.toContain(marker.toLowerCase());
    },
  );

  test('should let RequestTokenizer replace every synthetic customer ID', () => {
    // Assemble: the turn that carries the CSV back as a tool result
    const body = request('read-tool-reply');
    const detectors = buildDetectors([
      { kind: 'pattern', name: 'customer-id', prefix: 'CUST', pattern: String.raw`CUST-\d{4,}` },
    ]);

    // Act
    const result = new RequestTokenizer(
      detectors,
      new TokenMap(Uint8Array.from(Array(32).keys())),
    ).tokenize(body);

    // Assert: the recording held IDs, and none is left outside the untouched thinking blocks
    const unsigned = strings(
      (result.body as { messages: { content: unknown }[] }).messages.map((m) =>
        Array.isArray(m.content)
          ? (m.content as { type: string }[]).filter((b) => !b.type.endsWith('thinking'))
          : m.content,
      ),
    );
    expect(result.hits['pattern:customer-id']).toBeGreaterThan(0);
    for (const text of unsigned) expect(text).not.toMatch(/CUST-\d{4}/);
  });
});

const MARKERS: Markers = {
  home: '/Users/alice',
  user: 'alice',
  email: 'alice@corp.test',
  host: 'alice-mbp',
  extra: ['CorpName'],
};

const RAW_REQUEST = {
  model: 'claude-haiku-5-5',
  system: [
    { type: 'text', text: 'You are Claude Code, a long prompt.' },
    { type: 'text', text: 'More prompt.', cache_control: { type: 'ephemeral' } },
  ],
  tools: [
    {
      name: 'Read',
      description: 'Reads a file. Long description.',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'Path' } },
      },
    },
  ],
  metadata: { user_id: 'user_abc' },
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>CLAUDE.md for alice</system-reminder>' }],
    },
    { role: 'system', content: '# Environment for alice at /Users/alice on alice-mbp' },
    {
      role: 'user',
      content: 'Read /Users/alice/project/customers.csv for CorpName, mail alice@corp.test',
    },
  ],
};

describe('scrubFixture', () => {
  test('should replace system prompt and tool description text, keeping the block structure', () => {
    // Act
    const scrubbed = scrubRequest(RAW_REQUEST, MARKERS);

    // Assert
    expect(scrubbed.system).toEqual([
      { type: 'text', text: SYSTEM_STAND_IN },
      { type: 'text', text: SYSTEM_STAND_IN, cache_control: { type: 'ephemeral' } },
    ]);
    expect(scrubbed.tools).toEqual([
      {
        name: 'Read',
        description: TOOL_STAND_IN,
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string', description: TOOL_STAND_IN } },
        },
      },
    ]);
    expect(scrubbed.metadata).toEqual({});
    expect(scrubbed.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: REMINDER_STAND_IN }] },
      { role: 'system', content: SYSTEM_STAND_IN },
      {
        role: 'user',
        content: 'Read /home/dev/project/customers.csv for redacted, mail dev@example.com',
      },
    ]);
  });

  test('should replace personal markers in requests and response streams', () => {
    // Assemble
    const sse =
      'event: content_block_delta\ndata: {"text":"I read /Users/alice/x on alice-mbp for alice"}\n\n';

    // Act and Assert: every other byte is kept
    expect(scrubStream(sse, MARKERS)).toBe(
      'event: content_block_delta\ndata: {"text":"I read /home/dev/x on devbox for dev"}\n\n',
    );
  });

  test('should replace a marker split across deltas, keeping every event', () => {
    // Assemble: the path arrives in two input_json_delta chunks
    const delta = (json: string) =>
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":' +
      `{"type":"input_json_delta","partial_json":${JSON.stringify(json)}}}\n\n`;

    // Act
    const scrubbed = scrubStream(delta('{"file_path": "/Users') + delta('/alice/x"}'), MARKERS);

    // Assert: the replacement lands in the chunk where the match starts
    expect(scrubbed).toBe(delta('{"file_path": "/home/dev') + delta('/x"}'));
  });

  test('should refuse a delta it cannot rewrite byte for byte', () => {
    // Assemble: an escaped slash, which JSON.stringify would not write back the same way
    const sse = String.raw`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\/Users\/alice"}}`;

    // Act and Assert
    expect(() => scrubStream(sse, MARKERS)).toThrow(/byte for byte/);
  });

  test('should give the same output when run twice', () => {
    const once = scrubRequest(RAW_REQUEST, MARKERS);
    expect(scrubRequest(once, MARKERS)).toEqual(once);
  });
});
