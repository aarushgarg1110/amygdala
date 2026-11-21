import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';

describe('test isolation', () => {
  test('should run every test in a temporary home folder with no AMYGDALA_DIR', () => {
    expect(realpathSync(homedir()).startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(homedir()).toMatch(/amygdala-home-/);
    expect(process.env.AMYGDALA_DIR).toBeUndefined();
  });

  test.runIf(process.platform === 'darwin')(
    'should leave security no default keychain to write to',
    () => {
      const result = spawnSync('/usr/bin/security', ['default-keychain'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('A default keychain could not be found');
    },
  );
});
