import { join } from 'node:path';
import { CA_FILE } from './cert-store.ts';
import { LISTEN_HOST } from './proxy.ts';

/** The shells `shell-init` writes the function for; both accept the same POSIX function. */
export const SHELLS: readonly string[] = ['zsh', 'bash'];

// Each would send Claude Code somewhere amygdala does not decrypt: a protected claude refuses them.
const ROUTES_AROUND = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];
// Hosts listed here would skip the proxy; the function's claude never sees them.
const BYPASSES = ['NO_PROXY', 'no_proxy'];

/**
 * Off in a protected session, measured 11-22 on 2.1.330: Remote Control (until B5) and claude.ai
 * connectors, by the documented keys and the older ones together, in one --settings.
 */
export const CLAUDE_SETTINGS = {
  remoteControlAtStartup: false,
  disableRemoteControl: true,
  disableClaudeAiConnectors: true,
};

// R6's switches (feature flags stay on) and the documented connector switch.
const SWITCHES = {
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  DISABLE_FEEDBACK_COMMAND: '1',
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  DISABLE_ERROR_REPORTING: '1',
};

/** `text` as one single-quoted shell word: a quote inside becomes '\''. */
export const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export interface ShellTarget {
  readonly dir: string;
  readonly port: number;
  /** The node and entry point `status` runs with: the ones that ran `shell-init`. */
  readonly node: string;
  readonly entry: string;
}

/** The `claude` function for zsh and bash: protected, or refused; never an unprotected fallback. */
export function shellFunction({ dir, port, node, entry }: ShellTarget): string {
  const proxy = `http://${LISTEN_HOST}:${String(port)}`;
  const unset = [...BYPASSES, ...ROUTES_AROUND].map((name) => `-u ${name}`).join(' ');
  const set = [
    `HTTPS_PROXY=${quoted(proxy)}`,
    `https_proxy=${quoted(proxy)}`,
    `NODE_EXTRA_CA_CERTS=${quoted(join(dir, CA_FILE))}`,
    ...Object.entries(SWITCHES).map(([name, value]) => `${name}=${quoted(value)}`),
  ].join(' ');
  const notRunning =
    'amygdala is not running, so claude would not be protected: amygdala start (command claude runs unprotected)';
  return `claude() {
  if ! AMYGDALA_DIR=${quoted(dir)} ${quoted(node)} ${quoted(entry)} status >/dev/null 2>&1; then
    printf '%s\\n' ${quoted(notRunning)} >&2
    return 1
  fi
  local name
  for name in ${ROUTES_AROUND.join(' ')}; do
    case "$(printenv "$name")" in
      '' | 0 | false | FALSE | False) ;;
      *)
        printf '%s\\n' "$name is on, which would send claude around amygdala: use command claude for that session" >&2
        return 1
        ;;
    esac
  done
  env ${unset} ${set} claude --settings ${quoted(JSON.stringify(CLAUDE_SETTINGS))} "$@"
}
`;
}
