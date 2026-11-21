import { spawnSync } from 'node:child_process';

/** Runs `command` with `args`, writing `input` to its stdin. Swappable so tests can record calls. */
export type Run = (
  command: string,
  args: readonly string[],
  input?: string,
) => { readonly status: number | null; readonly stdout: string; readonly stderr: string };

/** The real `Run`: the command's exit status and its output as text. */
export const runProcess: Run = (command, args, input) => {
  const result = spawnSync(command, args, { input, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
