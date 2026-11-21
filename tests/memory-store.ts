// An in-memory SecretStore that records how it was asked, for tests of what uses the Keychain.
import { KeychainError, type SecretStore } from '../src/keychain.ts';

export class MemoryStore implements SecretStore {
  readonly secrets = new Map<string, string>();
  readonly calls: string[] = [];

  has(account: string): boolean {
    this.calls.push(`has ${account}`);
    return this.secrets.has(account);
  }

  read(account: string): string | undefined {
    this.calls.push(`read ${account}`);
    return this.secrets.get(account);
  }

  add(account: string, secret: string): void {
    this.calls.push(`add ${account}`);
    if (this.secrets.has(account))
      throw new KeychainError(`a key for ${account} is already in the Keychain`);
    this.secrets.set(account, secret);
  }

  remove(account: string): void {
    this.calls.push(`remove ${account}`);
    this.secrets.delete(account);
  }
}
