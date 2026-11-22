import { pipeline, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { restoreMessage, StreamRestorer } from './engine/restore.ts';
import { StreamParser, type StreamEvent } from './engine/stream.ts';
import type { TokenMap } from './engine/token-map.ts';
import type { TrustOptions } from './engine/trust.ts';
import { passThrough, withoutHopByHop, type Relay } from './intercept.ts';

/**
 * Puts real values back into a model reply. A stream is restored event by event as it arrives;
 * a whole JSON reply is restored at once; any other reply passes through. A reply that is still
 * compressed can't be read, so it becomes a 502 rather than placeholders reaching tools.
 */
export function restoringRelay(map: TokenMap, trust?: TrustOptions): Relay {
  return (reply, response) => {
    if (reply.headers['content-encoding'] !== undefined) {
      // Drained, not destroyed, so the upstream connection stays reusable.
      reply.resume();
      response.writeHead(502).end();
      return;
    }
    const type = String(reply.headers['content-type']);
    if (type.startsWith('text/event-stream')) streamed(map, trust)(reply, response);
    else if (type.startsWith('application/json')) whole(map, trust)(reply, response);
    else passThrough(reply, response);
  };
}

const streamed =
  (map: TokenMap, trust: TrustOptions | undefined): Relay =>
  (reply, response) => {
    const headers = withoutHopByHop(reply.headers);
    // Restored text changes the length, so the stream goes out chunked.
    delete headers['content-length'];
    response.writeHead(reply.statusCode, headers);
    // A UTF-8 character can arrive split across chunks; the decoder keeps its first bytes back.
    const decoder = new StringDecoder('utf8');
    const parser = new StreamParser();
    const restorer = new StreamRestorer(map, trust);
    const restored = (events: StreamEvent[]) =>
      events.map((event) => restorer.push(event)).join('');
    const restore = new Transform({
      transform(chunk: Buffer, encoding, done) {
        done(null, restored(parser.push(decoder.write(chunk))));
      },
      flush(done) {
        done(null, restored([...parser.push(decoder.end()), ...parser.end()]) + restorer.end());
      },
    });
    pipeline(reply, restore, response, () => undefined);
  };

const whole =
  (map: TokenMap, trust: TrustOptions | undefined): Relay =>
  (reply, response) => {
    const chunks: Buffer[] = [];
    reply.on('data', (chunk: Buffer) => chunks.push(chunk));
    reply.on('end', () => {
      const body = restoreMessage(Buffer.concat(chunks).toString('utf8'), map, trust);
      response.writeHead(reply.statusCode, {
        ...withoutHopByHop(reply.headers),
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
    });
  };
