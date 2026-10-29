// Turns a recorded Claude Code request/response pair into a fixture that is safe to publish:
// Anthropic's prompt text becomes short stand-ins (block structure kept) and the recorder's personal
// details become synthetic ones, in the request and in the response stream.
//
//   SCRUB_EMAIL=<recorder's email> node scripts/scrub-fixture.ts <raw-dir> <dump-number> <out-dir>
//   AMYGDALA_FIXTURE_FORBIDDEN=a,b   further strings to replace (company names, other paths)
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Markers {
  readonly home: string;
  readonly user: string;
  readonly email: string;
  readonly host: string;
  readonly extra: readonly string[];
}

export const SYSTEM_STAND_IN = 'System prompt text (replaced in this fixture).';
export const TOOL_STAND_IN = 'Tool description (replaced in this fixture).';
export const REMINDER_STAND_IN =
  '<system-reminder>Context Claude Code adds (replaced in this fixture).</system-reminder>';

/** `chunks` with `from` replaced as if they were one string; a replacement lands in the chunk where
 * its match starts, so a match split across chunks is still found and the chunk count is kept. */
function replaceAcross(chunks: readonly string[], from: string, to: string): string[] {
  const joined = chunks.join('');
  const out: string[] = [];
  let at = 0;
  let skipUntil = 0;
  for (const chunk of chunks) {
    let text = '';
    for (const end = at + chunk.length; at < end; at += 1) {
      if (at < skipUntil) continue;
      const match = from !== '' && joined.startsWith(from, at);
      text += match ? to : joined.charAt(at);
      if (match) skipUntil = at + from.length;
    }
    out.push(text);
  }
  return out;
}

/** `chunks` with every personal marker replaced; email and home first, since they contain the user. */
function scrubChunks(chunks: readonly string[], markers: Markers): string[] {
  const pairs: [string, string][] = [
    [markers.email, 'dev@example.com'],
    [markers.home, '/home/dev'],
    [markers.host, 'devbox'],
    ...markers.extra.map((marker): [string, string] => [marker, 'redacted']),
    [markers.user, 'dev'],
  ];
  return pairs.reduce<string[]>((out, [from, to]) => replaceAcross(out, from, to), [...chunks]);
}

/** `text` with every personal marker replaced. */
export function scrubText(text: string, markers: Markers): string {
  return scrubChunks([text], markers).join('');
}

function replaceDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(replaceDescriptions);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'description' && typeof item === 'string' ? TOOL_STAND_IN : replaceDescriptions(item),
    ]),
  );
}

function replaceReminders(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.trimStart().startsWith('<system-reminder>') ? REMINDER_STAND_IN : value;
  }
  if (Array.isArray(value)) return value.map(replaceReminders);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, replaceReminders(item)]),
  );
}

function scrubStrings(value: unknown, markers: Markers): unknown {
  if (typeof value === 'string') return scrubText(value, markers);
  if (Array.isArray(value)) return value.map((item) => scrubStrings(item, markers));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      scrubText(key, markers),
      scrubStrings(item, markers),
    ]),
  );
}

/** A request body with Anthropic's prompt text replaced and personal markers removed. */
export function scrubRequest(
  body: Record<string, unknown>,
  markers: Markers,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (typeof out.system === 'string') out.system = SYSTEM_STAND_IN;
  if (Array.isArray(out.system)) {
    out.system = (out.system as Record<string, unknown>[]).map((block) =>
      typeof block.text === 'string' ? { ...block, text: SYSTEM_STAND_IN } : block,
    );
  }
  if (Array.isArray(out.tools)) {
    out.tools = (out.tools as Record<string, unknown>[]).map((tool) => replaceDescriptions(tool));
  }
  if (typeof out.metadata === 'object' && out.metadata !== null) {
    out.metadata = Object.fromEntries(
      Object.entries(out.metadata).filter(([key]) => key !== 'user_id'),
    );
  }
  // Claude Code also sends part of its prompt as a "system"-role message inside the conversation.
  if (Array.isArray(out.messages)) {
    out.messages = (out.messages as Record<string, unknown>[]).map((message) =>
      message.role === 'system' ? { ...message, content: SYSTEM_STAND_IN } : message,
    );
  }
  out.messages = replaceReminders(out.messages);
  return scrubStrings(out, markers) as Record<string, unknown>;
}

interface DeltaValue {
  readonly line: number;
  readonly field: string;
  readonly value: string;
}

/** The string fields of a `content_block_delta` event line, keyed by content block and field. */
function deltaValues(line: string, number: number): [string, DeltaValue][] {
  if (!line.startsWith('data: ')) return [];
  const event: unknown = JSON.parse(line.slice('data: '.length));
  if (typeof event !== 'object' || event === null) return [];
  const { type, index, delta } = event as Record<string, unknown>;
  if (type !== 'content_block_delta' || typeof delta !== 'object' || delta === null) return [];
  return Object.entries(delta)
    .filter(
      (entry): entry is [string, string] => entry[0] !== 'type' && typeof entry[1] === 'string',
    )
    .map(([field, value]) => [`${String(index)}:${field}`, { line: number, field, value }]);
}

/** `line` with one delta value swapped, refusing any line whose encoding it would not keep. */
function rewriteDelta(line: string, { field, value }: DeltaValue, to: string): string {
  const from = `${JSON.stringify(field)}:${JSON.stringify(value)}`;
  const at = line.lastIndexOf(from);
  if (at === -1) throw new Error(`cannot rewrite this delta byte for byte: ${line}`);
  return `${line.slice(0, at)}${JSON.stringify(field)}:${JSON.stringify(to)}${line.slice(at + from.length)}`;
}

/**
 * A response stream with personal markers removed, also where one is split across a content
 * block's deltas, and every other byte and event kept.
 */
export function scrubStream(stream: string, markers: Markers): string {
  const lines = stream.split('\n');
  const blocks = new Map<string, DeltaValue[]>();
  lines.forEach((line, number) => {
    const values = deltaValues(line, number);
    if (values.length === 0) lines[number] = scrubText(line, markers);
    for (const [key, value] of values) blocks.set(key, [...(blocks.get(key) ?? []), value]);
  });
  for (const values of blocks.values()) {
    const scrubbed = scrubChunks(
      values.map((v) => v.value),
      markers,
    );
    values.forEach((value, i) => {
      const to = scrubbed[i] ?? value.value;
      if (to !== value.value) lines[value.line] = rewriteDelta(lines[value.line] ?? '', value, to);
    });
  }
  return lines.join('\n');
}

function main(): void {
  const [rawDir, dump, outDir] = process.argv.slice(2);
  const email = process.env.SCRUB_EMAIL;
  if (rawDir === undefined || dump === undefined || outDir === undefined || email === undefined) {
    throw new Error(
      'usage: SCRUB_EMAIL=<email> node scripts/scrub-fixture.ts <raw-dir> <n> <out-dir>',
    );
  }
  const markers: Markers = {
    home: homedir(),
    user: userInfo().username,
    email,
    host: hostname().replace(/\.local$/, ''),
    extra: (process.env.AMYGDALA_FIXTURE_FORBIDDEN ?? '').split(',').filter((m) => m !== ''),
  };
  const id = dump.padStart(3, '0');
  const bodyPath = join(rawDir, `${id}.body`);
  const body = JSON.parse(readFileSync(bodyPath, 'utf8')) as Record<string, unknown>;
  // Claude Code names its version inside the system prompt, which the scrubbed copy replaces.
  const version = /cc_version=(\d+\.\d+\.\d+)/.exec(JSON.stringify(body.system))?.[1];
  if (version === undefined) throw new Error(`no cc_version in the system prompt of ${bodyPath}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'request.json'),
    `${JSON.stringify(scrubRequest(body, markers), null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, 'response.sse'),
    scrubStream(readFileSync(join(rawDir, `${id}.resp`), 'utf8'), markers),
  );
  writeFileSync(
    join(outDir, 'meta.json'),
    `${JSON.stringify(
      {
        claude_code: version,
        model: body.model,
        recorded: statSync(bodyPath).mtime.toISOString().slice(0, 10),
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
