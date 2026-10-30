import { MAX_PREFIX, TOKEN_CHARS } from './placeholder.ts';
import { formatEvent, isRecord, type StreamEvent } from './stream.ts';
import type { TokenMap } from './token-map.ts';
import { PLACEHOLDER_CANDIDATE, restoreText } from './tokenize.ts';

/** The longest end of streamed text that could still become a placeholder: prefix, "_", 9 of 10. */
export const MAX_HOLDBACK_CHARS = MAX_PREFIX + 1 + TOKEN_CHARS - 1;

// An end of text that may be the start of a placeholder still arriving. Only the last MAX_PREFIX
// capitals of a run matter, because restoreText tries prefixes up to that length.
const PARTIAL_END = new RegExp(
  `[A-Z0-9]{1,${String(MAX_PREFIX)}}(?:_[a-z2-7]{0,${String(TOKEN_CHARS - 1)}})?$`,
);

/** Where the held end of `text` starts: never inside a complete placeholder. */
function holdFrom(text: string): number {
  let from = PARTIAL_END.exec(text)?.index ?? text.length;
  // Base32 has the digits 2-7, so a placeholder ending in one ("CUST_ubw2bbblc4") would otherwise
  // look like the start of a new run and be cut, its last digit held and the rest sent unrestored.
  for (const match of text.matchAll(PLACEHOLDER_CANDIDATE)) {
    if (match.index < from && from < match.index + match[0].length) {
      from = match.index + match[0].length;
    }
  }
  return from;
}

/**
 * Puts real values back into the text of a streamed reply. A placeholder can arrive split across
 * deltas ("**C" + "UST_…"), so each text block holds back an end that could still become one and
 * sends it with the next delta. Thinking is signed and tool arguments are A6's: both pass through.
 */
export class StreamRestorer {
  readonly #map: TokenMap;
  /** Per text block index, the end of its text not sent yet. */
  readonly #held = new Map<number, string>();

  constructor(map: TokenMap) {
    this.#map = map;
  }

  /** The text to send on for one event from StreamParser. */
  push(event: StreamEvent): string {
    const { block, data } = event;
    if (block?.type !== 'text' || !isRecord(data)) return event.raw;
    if (data.type === 'content_block_stop') return this.#flush(block.index) + event.raw;
    const { delta } = data;
    const isText =
      data.type === 'content_block_delta' && isRecord(delta) && delta.type === 'text_delta';
    if (!isText || typeof delta.text !== 'string') return event.raw;
    const text = (this.#held.get(block.index) ?? '') + delta.text;
    const from = holdFrom(text);
    this.#held.set(block.index, text.slice(from));
    const sent = restoreText(text.slice(0, from), this.#map);
    if (sent === delta.text) return event.raw;
    return formatEvent('content_block_delta', { ...data, delta: { ...delta, text: sent } });
  }

  /** Whatever is still held when the stream ends without closing its blocks. */
  end(): string {
    return [...this.#held.keys()].map((index) => this.#flush(index)).join('');
  }

  // Held text never completed a placeholder, so it goes out as it arrived.
  #flush(index: number): string {
    const held = this.#held.get(index) ?? '';
    this.#held.delete(index);
    if (held === '') return '';
    const delta = { type: 'text_delta', text: held };
    return formatEvent('content_block_delta', { type: 'content_block_delta', index, delta });
  }
}
