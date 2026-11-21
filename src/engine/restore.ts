import { MAX_PREFIX, TOKEN_CHARS } from './placeholder.ts';
import { formatEvent, isRecord, type Block, type StreamEvent } from './stream.ts';
import type { TokenMap } from './token-map.ts';
import { PLACEHOLDER_CANDIDATE, restoreText } from './tokenize.ts';

/** The longest end of streamed text that could still become a placeholder: prefix, "_", 9 of 10. */
export const MAX_HOLDBACK_CHARS = MAX_PREFIX + 1 + TOKEN_CHARS - 1;

/**
 * Tools that run on the user's machine, so their arguments get real values back. Tools that send
 * their arguments elsewhere (Artifact, WebFetch, SendMessage, connectors) and unknown tools are not
 * listed, so they keep placeholders.
 */
export const DEFAULT_TRUSTED_TOOLS: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Grep',
  'Glob',
  'Bash',
  'Monitor',
  'TaskStop',
  // Their own model calls go back through amygdala.
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
];

export interface RestorerOptions {
  /** Tool names whose arguments are restored. Replaces DEFAULT_TRUSTED_TOOLS. */
  readonly trustedTools?: readonly string[];
  /** Name prefixes of local MCP servers whose tools are restored, e.g. `mcp__plugin_ops_ops__`. */
  readonly trustedPrefixes?: readonly string[];
}

// "mcp__<server>__": the closing "__" keeps "mcp__ops__" from also trusting "mcp__opsx__".
const MCP_PREFIX = /^mcp__.+__$/u;
// claude.ai connectors are called from Anthropic's side, so real values in their arguments would
// leave the machine.
const CONNECTOR_PREFIX = 'mcp__claude_ai_';

function assertTrustedPrefix(prefix: string): void {
  if (!MCP_PREFIX.test(prefix)) {
    throw new Error(`trusted MCP prefix "${prefix}" must start with "mcp__" and end with "__"`);
  }
  if (prefix.startsWith(CONNECTOR_PREFIX)) {
    throw new Error(
      `trusted MCP prefix "${prefix}" names a claude.ai connector, which runs remotely`,
    );
  }
}

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
 * Puts real values back into a streamed reply: its text, and the arguments of trusted tools, which
 * run on this machine. A placeholder can arrive split across deltas ("**C" + "UST_…"), so each
 * such block holds back an end that could still become one and sends it with the next delta.
 * Thinking is signed, and other tools' arguments leave the machine: both pass through.
 */
export class StreamRestorer {
  readonly #map: TokenMap;
  readonly #trustedTools: ReadonlySet<string>;
  readonly #trustedPrefixes: readonly string[];
  /** Per block index, the end of its content not sent yet. */
  readonly #held = new Map<number, { readonly kind: Restorable; readonly text: string }>();

  constructor(map: TokenMap, options: RestorerOptions = {}) {
    const prefixes = options.trustedPrefixes ?? [];
    prefixes.forEach(assertTrustedPrefix);
    this.#map = map;
    this.#trustedTools = new Set(options.trustedTools ?? DEFAULT_TRUSTED_TOOLS);
    this.#trustedPrefixes = prefixes;
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
    const from = holdFrom(text);
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

  #trusts(name: string): boolean {
    return (
      this.#trustedTools.has(name) ||
      this.#trustedPrefixes.some((prefix) => name.startsWith(prefix))
    );
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
