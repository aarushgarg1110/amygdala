// What init and run need, for tests: in-memory stores and the real openssl minter.
import { OpensslMinter } from '../src/certs.ts';
import type { InitDeps } from '../src/init.ts';
import { MemoryStore } from './memory-store.ts';

export const MINTER = new OpensslMinter();

/** init's dependencies around `store`, with a fresh in-memory store for the host key. */
export function depsFor(store: MemoryStore, extra: Partial<InitDeps> = {}): InitDeps {
  return { store, tlsKeys: new MemoryStore(), minter: MINTER, ...extra };
}
