/** The content block an event belongs to, as its `content_block_start` described it. */
export interface Block {
  readonly index: number;
  readonly type: string;
  /** The tool's name, for a `tool_use` block. */
  readonly name: string | undefined;
}

/** One server-sent event, with the exact text it arrived as. */
export interface StreamEvent {
  /** Line endings included; joining every event's `raw` gives the stream back byte for byte. */
  readonly raw: string;
  /** The `event:` field, if the event had one. */
  readonly name: string | undefined;
  /** The `data:` lines joined with "\n" and parsed; undefined when there are none or they aren't JSON. */
  readonly data: unknown;
  readonly block: Block | undefined;
}

// The SSE spec ends a line at CRLF, LF or CR.
const LINE_END = /\r\n|\r|\n/;

/** Narrows an event's parsed `data` (or a field of it) to an object. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function parseData(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Splits a response stream into events as its chunks arrive. Each event keeps its original text,
 * so one nobody changes goes back out byte for byte (the API pads its JSON with spaces), and events
 * that carry a block `index` are tagged with that block.
 */
export class StreamParser {
  /** Text not yet split into lines. */
  #buffer = '';
  /** Text of the event being read, including any data-less lines folded in before it. */
  #raw = '';
  #name: string | undefined;
  #data: string[] = [];
  readonly #blocks = new Map<number, Block>();

  /** The events this chunk completes. */
  push(chunk: string): StreamEvent[] {
    this.#buffer += chunk;
    return this.#drain(false);
  }

  /** The rest once the stream ends: a last event without its blank line, then any leftover text. */
  end(): StreamEvent[] {
    const events = this.#drain(true);
    if (this.#buffer !== '') this.#line(this.#buffer, '');
    this.#buffer = '';
    const last = this.#dispatch();
    if (last !== undefined) events.push(last);
    if (this.#raw !== '') {
      events.push({ raw: this.#raw, name: undefined, data: undefined, block: undefined });
    }
    this.#raw = '';
    return events;
  }

  #drain(final: boolean): StreamEvent[] {
    const events: StreamEvent[] = [];
    for (let match = LINE_END.exec(this.#buffer); match !== null;) {
      // A CR at the end of what has arrived may be the first half of a CRLF: wait for the next chunk.
      if (!final && match[0] === '\r' && match.index === this.#buffer.length - 1) break;
      const line = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      const event = this.#line(line, match[0]);
      if (event !== undefined) events.push(event);
      match = LINE_END.exec(this.#buffer);
    }
    return events;
  }

  #line(text: string, ending: string): StreamEvent | undefined {
    this.#raw += text + ending;
    if (text === '') return this.#dispatch();
    if (text.startsWith(':')) return undefined;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    const value = colon === -1 ? '' : text.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') this.#name = value;
    if (field === 'data') this.#data.push(value);
    return undefined;
  }

  // Per the SSE spec a group with no data line is not an event; its text folds into the next one.
  #dispatch(): StreamEvent | undefined {
    const name = this.#name;
    this.#name = undefined;
    if (this.#data.length === 0) return undefined;
    const data = parseData(this.#data.join('\n'));
    const event = { raw: this.#raw, name, data, block: this.#blockOf(data) };
    this.#raw = '';
    this.#data = [];
    return event;
  }

  #blockOf(data: unknown): Block | undefined {
    if (!isRecord(data)) return undefined;
    const { type, index, content_block: started } = data;
    if (typeof index !== 'number') return undefined;
    if (type === 'content_block_start' && isRecord(started) && typeof started.type === 'string') {
      const name = typeof started.name === 'string' ? started.name : undefined;
      this.#blocks.set(index, { index, type: started.type, name });
    }
    const block = this.#blocks.get(index);
    if (type === 'content_block_stop') this.#blocks.delete(index);
    return block;
  }
}

/** An event in the API's framing; JSON never holds a raw line break, so one data line carries it. */
export function formatEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
