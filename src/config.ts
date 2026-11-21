import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, TomlError } from 'smol-toml';
import { buildDetectors, type Detector, type DetectorConfig } from './engine/detector.ts';
import { isRecord } from './engine/stream.ts';
import { trustRule, type TrustOptions } from './engine/trust.ts';

export const CONFIG_FILE = 'config.toml';

/** The hosts whose traffic is decrypted and scanned; every other host is tunnelled untouched. */
export const DEFAULT_INTERCEPT_HOSTS: readonly string[] = [
  'api.anthropic.com',
  'mcp-proxy.anthropic.com',
  'claude.ai',
  'http-intake.logs.us5.datadoghq.com',
];
// Every model request goes here, so a config that leaves it out protects nothing.
const API_HOST = 'api.anthropic.com';
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** What `amygdala init` writes. Its example detector is commented out, so it won't load until edited. */
export const DEFAULT_CONFIG = `# amygdala configuration. No secrets live here: the key is in the macOS Keychain.

# What to protect. Add at least one detector; amygdala won't start without one.
# [[detectors]]
# kind = "pattern"
# name = "customer-id"
# prefix = "CUST"
# pattern = 'CUST-\\d{4,}'
# ignore_case = false

[restore]
# trusted_tools = ["Read", "Bash"]   # leave out to use the built-in list
trusted_prefixes = []                # e.g. "mcp__plugin_myops_myops__"

[proxy]
intercept_hosts = [
  "api.anthropic.com",
  "mcp-proxy.anthropic.com",
  "claude.ai",
  "http-intake.logs.us5.datadoghq.com",
]
`;

export interface Config {
  readonly detectors: readonly Detector[];
  readonly trust: TrustOptions;
  readonly interceptHosts: readonly string[];
}

/** The config can't be used; the message names the file and the key at fault. */
export class ConfigError extends Error {
  constructor(file: string, message: string, options?: ErrorOptions) {
    super(`${file}: ${message}`, options);
    this.name = 'ConfigError';
  }
}

/** Reads a TOML table's fields by hand, so every unknown key or wrong type names its path. */
class Table {
  readonly file: string;
  readonly path: string;
  readonly #fields: Record<string, unknown>;

  constructor(file: string, path: string, value: unknown, allowed: readonly string[]) {
    this.file = file;
    this.path = path;
    if (!isRecord(value) || Array.isArray(value)) throw this.error('', 'must be a table');
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) throw this.error(key, 'unknown key');
    }
    this.#fields = value;
  }

  error(key: string, message: string, options?: ErrorOptions): ConfigError {
    const at = [this.path, key].filter((part) => part !== '').join('.');
    return new ConfigError(this.file, `${at}: ${message}`, options);
  }

  has(key: string): boolean {
    return this.#fields[key] !== undefined;
  }

  /** The nested table at `key` with only `allowed` keys, or undefined when it is absent. */
  table(key: string, allowed: readonly string[]): Table | undefined {
    if (!this.has(key)) return undefined;
    const path = [this.path, key].filter((part) => part !== '').join('.');
    return new Table(this.file, path, this.#fields[key], allowed);
  }

  string(key: string): string {
    const value = this.#fields[key];
    if (typeof value !== 'string') throw this.error(key, 'must be a string');
    return value;
  }

  boolean(key: string): boolean {
    const value = this.#fields[key];
    if (typeof value !== 'boolean') throw this.error(key, 'must be true or false');
    return value;
  }

  strings(key: string): string[] {
    const value = this.#fields[key];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw this.error(key, 'must be a list of strings');
    }
    return value;
  }

  tables(key: string): unknown[] {
    const value = this.#fields[key] ?? [];
    if (!Array.isArray(value)) throw this.error(key, 'must be a list of [[tables]]');
    return value as unknown[];
  }
}

function detectorsFrom(root: Table): Detector[] {
  const entries = root.tables('detectors');
  if (entries.length === 0) {
    throw new ConfigError(root.file, 'no detectors configured: add a [[detectors]] entry');
  }
  const configs = entries.map((entry, i): DetectorConfig => {
    const table = new Table(root.file, `detectors[${String(i)}]`, entry, [
      'kind',
      'name',
      'prefix',
      'pattern',
      'ignore_case',
    ]);
    const kind = table.string('kind');
    if (kind !== 'pattern') throw table.error('kind', `unknown detector kind "${kind}"`);
    return {
      kind,
      name: table.string('name'),
      prefix: table.string('prefix'),
      pattern: table.string('pattern'),
      ignoreCase: table.has('ignore_case') && table.boolean('ignore_case'),
    };
  });
  // buildDetectors checks entries against each other (duplicates), so the first prefix of the list
  // that fails to build names the entry at fault.
  configs.forEach((config, i) => {
    try {
      buildDetectors(configs.slice(0, i + 1));
    } catch (error) {
      throw new ConfigError(root.file, `detectors[${String(i)}]: ${(error as Error).message}`, {
        cause: error,
      });
    }
  });
  return [...buildDetectors(configs)];
}

function trustFrom(root: Table): TrustOptions {
  const table = root.table('restore', ['trusted_tools', 'trusted_prefixes']);
  if (table === undefined) return {};
  const prefixes = table.has('trusted_prefixes') ? table.strings('trusted_prefixes') : [];
  prefixes.forEach((prefix, i) => {
    try {
      trustRule({ trustedPrefixes: [prefix] });
    } catch (error) {
      throw table.error(`trusted_prefixes[${String(i)}]`, (error as Error).message, {
        cause: error,
      });
    }
  });
  return {
    ...(table.has('trusted_tools') ? { trustedTools: table.strings('trusted_tools') } : {}),
    trustedPrefixes: prefixes,
  };
}

function hostsFrom(root: Table): string[] {
  const table = root.table('proxy', ['intercept_hosts']);
  if (!table?.has('intercept_hosts')) return [...DEFAULT_INTERCEPT_HOSTS];
  // Host names ignore case, so compare and store them in lower case.
  const hosts = table.strings('intercept_hosts').map((host) => host.toLowerCase());
  if (hosts.length === 0) throw table.error('intercept_hosts', 'must not be empty');
  hosts.forEach((host, i) => {
    if (!HOST_NAME.test(host)) {
      throw table.error(
        `intercept_hosts[${String(i)}]`,
        `"${host}" is not a bare host name (no scheme, port or path)`,
      );
    }
  });
  if (!hosts.some((host) => host === API_HOST)) {
    throw table.error('intercept_hosts', `must include ${API_HOST}, which carries every request`);
  }
  return hosts;
}

/** The config in `text`, fully checked; `file` only names where it came from in errors. */
export function parseConfig(text: string, file: string): Config {
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    // Only the parser's first line: the rest quotes the file, which may hold private patterns.
    const reason = error.message.replace(/\n[\s\S]*$/, '');
    throw new ConfigError(
      file,
      `not valid TOML at line ${String(error.line)}, column ${String(error.column)}: ${reason}`,
      { cause: error },
    );
  }
  const root = new Table(file, '', document, ['detectors', 'restore', 'proxy']);
  return {
    detectors: detectorsFrom(root),
    trust: trustFrom(root),
    interceptHosts: hostsFrom(root),
  };
}

/** `<dir>/config.toml`, parsed and checked. */
export function loadConfig(dir: string): Config {
  const file = join(dir, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(file, 'no config here: run `amygdala init`', { cause: error });
    }
    throw error;
  }
  return parseConfig(text, file);
}
