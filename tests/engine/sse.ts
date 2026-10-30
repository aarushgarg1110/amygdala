// Builders and readers for server-sent event streams, shared by the stream and restore tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StreamParser, type StreamEvent } from '../../src/engine/stream.ts';

export const FIXTURES = 'tests/fixtures/claude-code';
export const recorded = (scenario: string) =>
  readFileSync(join(FIXTURES, scenario, 'response.sse'), 'utf8');

/** Every event from pushing `chunks` in order and then ending the stream. */
export function parse(...chunks: string[]): StreamEvent[] {
  const parser = new StreamParser();
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.end()];
}

/** `text` cut at each of `points` (repeats give empty chunks). */
export function cut(text: string, points: readonly number[]): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (const point of [...points].sort((a, b) => a - b)) {
    chunks.push(text.slice(start, point));
    start = point;
  }
  return [...chunks, text.slice(start)];
}

export const event = (name: string, data: object) =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
export const start = (index: number, block: object) =>
  event('content_block_start', { type: 'content_block_start', index, content_block: block });
export const delta = (index: number, body: object) =>
  event('content_block_delta', { type: 'content_block_delta', index, delta: body });
export const stop = (index: number) =>
  event('content_block_stop', { type: 'content_block_stop', index });
