// Runs before every test file (vitest setupFiles). Tests, and mutants of the code they run, must
// never reach the real data folder or the login keychain: with HOME in a temporary folder,
// ~/.amygdala lands there, and `security` finds no default keychain, so a command that loses its
// keychain path fails instead of writing to the login keychain.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const HOME = mkdtempSync(join(tmpdir(), 'amygdala-home-'));
process.env.HOME = HOME;
// A value from the developer's own shell must not leak into a test.
delete process.env.AMYGDALA_DIR;

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});
