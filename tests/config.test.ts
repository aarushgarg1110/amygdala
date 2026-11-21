import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CONFIG_FILE,
  ConfigError,
  DEFAULT_CONFIG,
  DEFAULT_INTERCEPT_HOSTS,
  loadConfig,
  parseConfig,
} from '../src/config.ts';
import { trustRule } from '../src/engine/trust.ts';

const FILE = '/data/config.toml';
const DETECTOR = `[[detectors]]
kind = "pattern"
name = "customer-id"
prefix = "CUST"
pattern = 'CUST-\\d{4,}'
`;
// The default file with its example detector switched on, as a user would edit it.
const UNCOMMENTED = DEFAULT_CONFIG.replace(
  /^# (\[\[detectors\]\]|kind|name|prefix|pattern|ignore_case)/gm,
  '$1',
);

/** The message `parseConfig` refuses `text` with. */
function refusal(text: string): string {
  try {
    parseConfig(text, FILE);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('parseConfig accepted the config');
}

describe('parseConfig', () => {
  test('should load the default file once its example detector is uncommented', () => {
    // Act
    const config = parseConfig(UNCOMMENTED, FILE);

    // Assert
    expect(config.detectors.map((d) => [d.name, d.prefix])).toEqual([
      ['pattern:customer-id', 'CUST'],
    ]);
    expect(config.detectors[0]?.find('order CUST-0001')).toEqual([
      { start: 6, end: 15, canonical: 'CUST-0001' },
    ]);
    expect(config.trust).toEqual({ trustedPrefixes: [] });
    expect(config.interceptHosts).toEqual(DEFAULT_INTERCEPT_HOSTS);
  });

  test('should refuse the default file as written, which has no detector', () => {
    expect(refusal(DEFAULT_CONFIG)).toBe(
      `${FILE}: no detectors configured: add a [[detectors]] entry`,
    );
  });

  test('should pass ignore_case to the detector', () => {
    // Act
    const [detector] = parseConfig(`${DETECTOR}ignore_case = true\n`, FILE).detectors;

    // Assert: every spelling gets one canonical form
    expect(detector?.find('cust-0001')).toEqual([{ start: 0, end: 9, canonical: 'CUST-0001' }]);
  });

  test('should take trusted tools and MCP prefixes from restore', () => {
    // Act
    const { trust } = parseConfig(
      `${DETECTOR}[restore]\ntrusted_tools = ["Read"]\ntrusted_prefixes = ["mcp__plugin_ops_ops__"]\n`,
      FILE,
    );
    const trusts = trustRule(trust);

    // Assert
    expect(trust).toEqual({ trustedTools: ['Read'], trustedPrefixes: ['mcp__plugin_ops_ops__'] });
    expect([trusts('Read'), trusts('Bash'), trusts('mcp__plugin_ops_ops__fetch')]).toEqual([
      true,
      false,
      true,
    ]);
  });

  test.each([
    ['a [detector] table', `${DETECTOR}[detector]\nx = 1\n`, 'detector: unknown key'],
    [
      'a misspelled field',
      DETECTOR.replace('pattern =', 'patern ='),
      'detectors[0].patern: unknown key',
    ],
    [
      'an unknown restore key',
      `${DETECTOR}[restore]\ntrusted = []\n`,
      'restore.trusted: unknown key',
    ],
    ['an unknown proxy key', `${DETECTOR}[proxy]\nport = 1\n`, 'proxy.port: unknown key'],
  ])('should refuse an unknown key, naming its path: %s', (label, text, message) => {
    expect(refusal(text)).toBe(`${FILE}: ${message}`);
  });

  test.each([
    [
      'a number pattern',
      DETECTOR.replace(/pattern = .*/, 'pattern = 5'),
      'detectors[0].pattern: must be a string',
    ],
    ['a missing name', DETECTOR.replace(/name = .*\n/, ''), 'detectors[0].name: must be a string'],
    [
      'a string ignore_case',
      `${DETECTOR}ignore_case = "yes"\n`,
      'detectors[0].ignore_case: must be true or false',
    ],
    [
      'a string trusted_tools',
      `${DETECTOR}[restore]\ntrusted_tools = "Read"\n`,
      'restore.trusted_tools: must be a list of strings',
    ],
    [
      'a number among the trusted tools',
      `${DETECTOR}[restore]\ntrusted_tools = ["Read", 1]\n`,
      'restore.trusted_tools: must be a list of strings',
    ],
    [
      'a number among the hosts',
      `${DETECTOR}[proxy]\nintercept_hosts = ["api.anthropic.com", 3]\n`,
      'proxy.intercept_hosts: must be a list of strings',
    ],
    [
      'an empty host list',
      `${DETECTOR}[proxy]\nintercept_hosts = []\n`,
      'proxy.intercept_hosts: must not be empty',
    ],
    ['restore as a value', `restore = 1\n${DETECTOR}`, 'restore: must be a table'],
    ['detectors as a string', 'detectors = "x"\n', 'detectors: must be a list of [[tables]]'],
    ['a detector that is not a table', 'detectors = [1]\n', 'detectors[0]: must be a table'],
  ])('should refuse a value of the wrong type, naming its path: %s', (label, text, message) => {
    expect(refusal(text)).toBe(`${FILE}: ${message}`);
  });

  test('should refuse a TOML syntax error with its line and column', () => {
    // Act
    const message = refusal(`${DETECTOR}x = [1,\n b`);

    // Assert: the parser's reason without the lines of the file it quotes
    expect(message).toBe(
      `${FILE}: not valid TOML at line 7, column 2: Invalid TOML document: invalid value`,
    );
  });

  test.each([
    [
      'without the API host',
      '["claude.ai"]',
      'proxy.intercept_hosts: must include api.anthropic.com',
    ],
    [
      'with a scheme',
      '["https://api.anthropic.com"]',
      'proxy.intercept_hosts[0]: "https://api.anthropic.com" is not a bare host name',
    ],
    [
      'with a port',
      '["api.anthropic.com:443"]',
      'proxy.intercept_hosts[0]: "api.anthropic.com:443" is not a bare host name',
    ],
    [
      'with a path',
      '["api.anthropic.com", "claude.ai/x"]',
      'proxy.intercept_hosts[1]: "claude.ai/x" is not a bare host name',
    ],
    [
      'a single label',
      '["localhost"]',
      'proxy.intercept_hosts[0]: "localhost" is not a bare host name',
    ],
  ])(
    'should refuse intercept hosts that are not bare host names or miss the API host: %s',
    (label, hosts, message) => {
      expect(refusal(`${DETECTOR}[proxy]\nintercept_hosts = ${hosts}\n`)).toContain(
        `${FILE}: ${message}`,
      );
    },
  );

  test.todo('should require the API host itself, not a host containing its name');

  test('should keep intercept hosts given in any letter case, in lower case', () => {
    const { interceptHosts } = parseConfig(
      `${DETECTOR}[proxy]\nintercept_hosts = ["API.Anthropic.com", "claude.ai"]\n`,
      FILE,
    );
    expect(interceptHosts).toEqual(['api.anthropic.com', 'claude.ai']);
  });

  test.each([
    [
      'an invalid regex',
      DETECTOR.replace(/pattern = .*/, "pattern = '('"),
      'detectors[0]: detector "customer-id": invalid pattern',
    ],
    [
      'a duplicate prefix',
      `${DETECTOR}${DETECTOR.replace('customer-id', 'other')}`,
      'detectors[1]: duplicate prefix "CUST"',
    ],
    [
      'an unknown kind',
      DETECTOR.replace('kind = "pattern"', 'kind = "smiles"'),
      'detectors[0].kind: unknown detector kind "smiles"',
    ],
    [
      'a lowercase prefix',
      DETECTOR.replace('prefix = "CUST"', 'prefix = "cust"'),
      'detectors[0]: prefix must be',
    ],
  ])('should refuse a bad detector, naming its index: %s', (label, text, message) => {
    expect(refusal(text)).toContain(`${FILE}: ${message}`);
  });

  test.each([
    [
      'not ending with __',
      '["mcp__ops"]',
      'restore.trusted_prefixes[0]: trusted MCP prefix "mcp__ops" must start',
    ],
    [
      'the second one',
      '["mcp__a__", "plugin__b__"]',
      'restore.trusted_prefixes[1]: trusted MCP prefix "plugin__b__" must start',
    ],
    [
      'a claude.ai connector',
      '["mcp__claude_ai_Notion__"]',
      'restore.trusted_prefixes[0]: trusted MCP prefix "mcp__claude_ai_Notion__" names a claude.ai connector',
    ],
  ])('should refuse a bad MCP prefix, naming its index: %s', (label, prefixes, message) => {
    expect(refusal(`${DETECTOR}[restore]\ntrusted_prefixes = ${prefixes}\n`)).toContain(
      `${FILE}: ${message}`,
    );
  });

  test('should refuse an empty file', () => {
    expect(refusal('')).toBe(`${FILE}: no detectors configured: add a [[detectors]] entry`);
  });
});

describe('loadConfig', () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'amygdala-config-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('should read config.toml from the data folder', () => {
    // Assemble
    const dir = tempDir();
    writeFileSync(join(dir, CONFIG_FILE), UNCOMMENTED);

    // Act and Assert
    expect(loadConfig(dir).detectors).toHaveLength(1);
  });

  test('should refuse a missing file and point to amygdala init', () => {
    const dir = tempDir();
    expect(() => loadConfig(dir)).toThrow(
      `${join(dir, CONFIG_FILE)}: no config here: run \`amygdala init\``,
    );
  });

  test('should pass on a read error other than a missing file', () => {
    // Assemble: a folder where the file should be
    const dir = tempDir();
    mkdirSync(join(dir, CONFIG_FILE));

    // Act and Assert
    expect(() => loadConfig(dir)).toThrow(expect.objectContaining({ code: 'EISDIR' }));
  });
});
