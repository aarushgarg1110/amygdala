import type http from 'node:http';
import type { Detector } from './engine/detector.ts';
import { createOwnKeyDetector, OWN_KEY_DETECTOR } from './engine/detectors/own-key.ts';
import { KeyCollisionError, RequestTokenizer } from './engine/request.ts';
import { isRecord } from './engine/stream.ts';
import { PlaceholderCollisionError, TokenMap } from './engine/token-map.ts';
import { tokenizeText } from './engine/tokenize.ts';
import type { TrustOptions } from './engine/trust.ts';
import type { Forward, RequestHandler } from './intercept.ts';
import { restoringRelay } from './reply.ts';

/** Anthropic refuses Messages requests over 32 MB, so nothing valid is ever larger. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
// The only host whose model requests are rewritten; on any other host the same path is just scanned.
const API_HOST = 'api.anthropic.com';
const MODEL_PATH = /^\/v1\/messages(?:\/|$)/;
// A model reply must arrive readable to be restored (the R1 and R5 recorders asked the same).
const READABLE = { 'accept-encoding': 'identity' };
// The decision's path when even the path couldn't be scanned: the raw one might hold a value.
const UNSCANNED = '(not scanned)';

/** What happened to one request, for the audit log (B4). It never holds a value. */
export interface Decision {
  readonly host: string;
  readonly method: string;
  /** The path without its query, protected values replaced by placeholders. */
  readonly path: string;
  readonly action: 'forwarded' | 'tokenized' | 'blocked';
  readonly reason: string | undefined;
  readonly hits: Readonly<Record<string, number>>;
  readonly images: number;
  readonly documents: number;
  /** The body has a `thread` field: the conversation is kept on Anthropic's side (Q10). */
  readonly thread: boolean;
}

export interface ScrubOptions {
  readonly key: Uint8Array;
  /** The config's detectors; amygdala's own key is always detected on top of them. */
  readonly detectors: readonly Detector[];
  readonly forward: Forward;
  readonly report: (decision: Decision) => void;
  /** Shared with the restorer, which needs the placeholders issued here. */
  readonly map?: TokenMap;
  /** Which tools get real values back in their arguments (the config's [restore] table). */
  readonly trust?: TrustOptions;
  readonly maxBodyBytes?: number;
}

type Body =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: string; readonly gone: boolean };

type Hits = Record<string, number>;

interface Counted {
  readonly images: number;
  readonly documents: number;
  readonly thread: boolean;
}

type Verdict =
  | (Counted & { readonly action: 'blocked'; readonly reason: string })
  | (Counted & {
      readonly action: 'forwarded' | 'tokenized';
      readonly reason: undefined;
      readonly send: Buffer;
    });

const blocked = (reason: string, thread: boolean): Verdict => ({
  action: 'blocked',
  reason,
  images: 0,
  documents: 0,
  thread,
});

/** The whole body, unless it grows past `limit` (reading stops there) or the client leaves first. */
function readBody(request: http.IncomingMessage, limit: number, done: (body: Body) => void) {
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  const settle = (body: Body) => {
    if (settled) return;
    settled = true;
    done(body);
  };
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > limit) {
      request.pause();
      settle({ ok: false, reason: `the body is over ${String(limit)} bytes`, gone: false });
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    settle({ ok: true, bytes: Buffer.concat(chunks) });
  });
  request.on('close', () => {
    settle({ ok: false, reason: 'the client left before the body was complete', gone: true });
  });
}

// A malformed escape can't hide a value from the raw scan, so it just stays as it was.
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function add(into: Hits, from: Readonly<Record<string, number>>) {
  for (const [name, count] of Object.entries(from)) into[name] = (into[name] ?? 0) + count;
}

const counts = (hits: Readonly<Record<string, number>>) =>
  Object.entries(hits)
    .map(([name, count]) => `${name}: ${String(count)}`)
    .join(', ');

function block(response: http.ServerResponse, reason: string, close: boolean) {
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: `amygdala blocked this request: ${reason}` },
  });
  response.writeHead(400, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    // The unread rest of the body would be taken for the next request, so the connection ends.
    ...(close ? { connection: 'close' } : {}),
  });
  response.end(body);
}

interface Scanning {
  readonly request: http.IncomingMessage;
  readonly bytes: Buffer;
  readonly model: boolean;
  readonly url: string;
  readonly hits: Hits;
  readonly scan: (text: string, hits: Hits) => string;
  readonly tokenizer: RequestTokenizer;
}

function judge({ request, bytes, model, url, hits, scan, tokenizer }: Scanning): Verdict {
  // The URL and headers can't be rewritten safely, so a value there blocks the request.
  const outside: Hits = {};
  scan(`${url}\n${decoded(url)}\n${request.rawHeaders.join('\n')}`, outside);
  add(hits, outside);
  if (Object.keys(outside).length > 0) {
    return blocked(`a protected value in the URL or headers (${counts(outside)})`, false);
  }
  if (request.headers['content-encoding'] !== undefined) {
    return blocked('a compressed body cannot be scanned', false);
  }
  if (bytes.length === 0) {
    return {
      action: 'forwarded',
      reason: undefined,
      send: bytes,
      images: 0,
      documents: 0,
      thread: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return blocked('the body is not JSON', false);
  }
  const thread = isRecord(parsed) && parsed.thread !== undefined;
  const result = tokenizer.tokenize(parsed);
  add(hits, result.hits);
  if ((result.hits[OWN_KEY_DETECTOR] ?? 0) > 0) {
    return blocked("it holds amygdala's own key", thread);
  }
  const found = Object.keys(result.hits).length > 0;
  if (found && !model) {
    return blocked(`a protected value outside a model request (${counts(result.hits)})`, thread);
  }
  const { images, documents } = result;
  return found
    ? {
        action: 'tokenized',
        reason: undefined,
        send: Buffer.from(JSON.stringify(result.body)),
        images,
        documents,
        thread,
      }
    : { action: 'forwarded', reason: undefined, send: bytes, images, documents, thread };
}

/**
 * The intercept handler's outbound half. Each request is read whole before anything is sent. A
 * model request goes up with its protected values replaced; any other request goes up unchanged
 * when it holds none and is blocked when it does; whatever can't be scanned is blocked (4.1, 4.3).
 */
export function createScrubber(options: ScrubOptions): RequestHandler {
  const map = options.map ?? new TokenMap(options.key);
  const detectors = [...options.detectors, createOwnKeyDetector(options.key)];
  const tokenizer = new RequestTokenizer(detectors, map);
  const limit = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const relay = restoringRelay(map, options.trust);
  const scan = (text: string, hits: Hits) => {
    const result = tokenizeText(text, detectors, map);
    add(hits, result.hits);
    return result.text;
  };

  return (request, response, target) => {
    // Node's server sets both on every request it parses.
    const url = String(request.url);
    const rawPath = url.replace(/\?.*$/s, '');
    const model = target.host === API_HOST && request.method === 'POST' && MODEL_PATH.test(rawPath);
    readBody(request, limit, (body) => {
      const hits: Hits = {};
      let path = UNSCANNED;
      let verdict: Verdict;
      try {
        path = scan(decoded(rawPath), {});
        verdict = body.ok
          ? judge({ request, bytes: body.bytes, model, url, hits, scan, tokenizer })
          : blocked(body.reason, false);
      } catch (error) {
        const collided =
          error instanceof PlaceholderCollisionError || error instanceof KeyCollisionError;
        verdict = blocked(
          collided ? 'two values produced one placeholder' : 'the scan failed',
          false,
        );
      }
      options.report({
        host: target.host,
        method: String(request.method),
        path,
        action: verdict.action,
        reason: verdict.reason,
        hits,
        images: verdict.images,
        documents: verdict.documents,
        thread: verdict.thread,
      });
      if (verdict.action !== 'blocked') {
        options.forward(request, response, target, {
          body: verdict.send,
          ...(model ? { headers: READABLE, relay } : {}),
        });
      } else if (body.ok) block(response, verdict.reason, false);
      else if (!body.gone) block(response, verdict.reason, true);
    });
  };
}
