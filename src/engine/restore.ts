import { MAX_PREFIX, TOKEN_CHARS } from './placeholder.ts';
import { formatEvent, isRecord, type Block, type StreamEvent } from './stream.ts';
import type { TokenMap } from './token-map.ts';
import { restoreText } from './tokenize.ts';
import { trustRule, type TrustOptions } from './trust.ts';

/** The longest end of streamed text that could still become a placeholder: prefix, "_", 9 of 10. */
export const MAX_HOLDBACK_CHARS = MAX_PREFIX + 1 + TOKEN_CHARS - 1;

/** A block whose content is restored: the delta type that carries it and how originals go in. */
interface Restorable {
  readonly delta: string;
  readonly field: string;
  readonly encode: ((original: string) => string) | undefined;
}

// Text reaches the screen as it is; tool arguments are JSON text, so an original goes inside a JSON
// string and must be escaped there.
const TEXT: Restorable = { delta: 'text_delta', field: 'text', encode: undefined };
const ARGUMENTS: Restorable = {
  delta: 'input_json_delta',
  field: 'partial_json',
  encode: (original) => JSON.stringify(original).slice(1, -1),
};

// What may follow "PREFIX_" in a placeholder still arriving: fewer than its TOKEN_CHARS characters.
const TOKEN_START = new RegExp(`^[a-z2-7]{0,${String(TOKEN_CHARS - 1)}}$`);

/** Whether `end` could still grow into a placeholder with one of `prefixes`. */
function couldGrow(end: string, prefixes: ReadonlySet<string>): boolean {
  for (const prefix of prefixes) {
    const head = `${prefix}_`;
    if (head.startsWith(end)) return true;
    if (end.startsWith(head) && TOKEN_START.test(end.slice(head.length))) return true;
  }
  return false;
}

/**
 * Where the held end of `text` starts: the longest end that could still grow into a placeholder
 * the map has issued, so with nothing issued nothing waits. Prefixes start with a letter and the
 * part after "_" is lower case, so digits and complete placeholders are never held.
 */
function holdFrom(text: string, prefixes: ReadonlySet<string>): number {
  for (let from = Math.max(0, text.length - MAX_HOLDBACK_CHARS); from < text.length; from++) {
    if (couldGrow(text.slice(from), prefixes)) return from;
  }
  return text.length;
}

/**
 * Puts real values back into a streamed reply: its text, and the arguments of trusted tools, which
 * run on this machine. A placeholder can arrive split across deltas ("**C" + "UST_…"), so each
 * such block holds back an end that could still become one and sends it with the next delta.
 * Thinking is signed, and other tools' arguments leave the machine: both pass through.
 */
export class StreamRestorer {
  readonly #map: TokenMap;
  readonly #trusts: (name: string) => boolean;
  /** Per block index, the end of its content not sent yet. */
  readonly #held = new Map<number, { readonly kind: Restorable; readonly text: string }>();

  constructor(map: TokenMap, options: TrustOptions = {}) {
    this.#map = map;
    this.#trusts = trustRule(options);
  }

  /** The text to send on for one event from StreamParser. */
  push(event: StreamEvent): string {
    const { block, data } = event;
    if (block === undefined || !isRecord(data)) return event.raw;
    const kind = this.#restorable(block);
    if (kind === undefined) return event.raw;
    if (data.type === 'content_block_stop') return this.#flush(block.index) + event.raw;
    const { delta } = data;
    if (data.type !== 'content_block_delta' || !isRecord(delta) || delta.type !== kind.delta) {
      return event.raw;
    }
    const piece = delta[kind.field];
    if (typeof piece !== 'string') return event.raw;
    const text = (this.#held.get(block.index)?.text ?? '') + piece;
    const from = holdFrom(text, this.#map.prefixes);
    this.#held.set(block.index, { kind, text: text.slice(from) });
    const sent = restoreText(text.slice(0, from), this.#map, kind.encode);
    if (sent === piece) return event.raw;
    return formatEvent('content_block_delta', { ...data, delta: { ...delta, [kind.field]: sent } });
  }

  /** Whatever is still held when the stream ends without closing its blocks. */
  end(): string {
    return [...this.#held.keys()].map((index) => this.#flush(index)).join('');
  }

  #restorable(block: Block): Restorable | undefined {
    if (block.type === 'text') return TEXT;
    if (block.type === 'tool_use' && block.name !== undefined && this.#trusts(block.name)) {
      return ARGUMENTS;
    }
    return undefined;
  }

  // Held content never completed a placeholder, so it goes out as it arrived.
  #flush(index: number): string {
    const held = this.#held.get(index);
    this.#held.delete(index);
    if (held === undefined || held.text === '') return '';
    const delta = { type: held.kind.delta, [held.kind.field]: held.text };
    return formatEvent('content_block_delta', { type: 'content_block_delta', index, delta });
  }
}

/** `value` with every string in it restored, object keys included; `value` itself if none changed. */
function restoreValue(value: unknown, map: TokenMap): unknown {
  if (typeof value === 'string') return restoreText(value, map);
  if (Array.isArray(value)) {
    const items = value.map((item: unknown) => restoreValue(item, map));
    return items.every((item, i) => item === value[i]) ? value : items;
  }
  if (!isRecord(value)) return value;
  let changed = false;
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value)) {
    const restoredKey = restoreText(key, map);
    const restoredItem = restoreValue(item, map);
    if (restoredKey !== key || restoredItem !== item) changed = true;
    entries.push([restoredKey, restoredItem]);
  }
  return changed ? Object.fromEntries(entries) : value;
}

/** One content block of a whole reply, by StreamRestorer's rules; `block` itself if unchanged. */
function restoreBlock(block: unknown, map: TokenMap, trusts: (name: string) => boolean): unknown {
  if (!isRecord(block)) return block;
  if (block.type === 'text' && typeof block.text === 'string') {
    const text = restoreText(block.text, map);
    return text === block.text ? block : { ...block, text };
  }
  if (block.type === 'tool_use' && typeof block.name === 'string' && trusts(block.name)) {
    const input = restoreValue(block.input, map);
    return input === block.input ? block : { ...block, input };
  }
  return block;
}

/**
 * Puts real values back into a reply that arrived as one JSON body instead of a stream, by the same
 * rules as StreamRestorer. Strings go back unescaped, because the body is re-serialized as a whole.
 * Anything that isn't a reply comes back unchanged: at worst a placeholder stays on screen.
 */
export function restoreMessage(body: string, map: TokenMap, options: TrustOptions = {}): string {
  const trusts = trustRule(options);
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(message) || !Array.isArray(message.content)) return body;
  const original: unknown[] = message.content;
  const content = original.map((block) => restoreBlock(block, map, trusts));
  if (content.every((block, i) => block === original[i])) return body;
  return JSON.stringify({ ...message, content });
}
