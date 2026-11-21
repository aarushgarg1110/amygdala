/**
 * Tools that run on the user's machine, so their arguments get real values back. Tools that send
 * their arguments elsewhere (Artifact, WebFetch, SendMessage, connectors) and unknown tools are not
 * listed, so they keep placeholders.
 */
export const DEFAULT_TRUSTED_TOOLS: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Grep',
  'Glob',
  'Bash',
  'Monitor',
  'TaskStop',
  // Their own model calls go back through amygdala.
  'Agent',
  'Workflow',
  'Skill',
  'ToolSearch',
  'AskUserQuestion',
  'TodoWrite',
  'EnterPlanMode',
  'ExitPlanMode',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
];

export interface TrustOptions {
  /** Tool names whose arguments are restored. Replaces DEFAULT_TRUSTED_TOOLS. */
  readonly trustedTools?: readonly string[];
  /** Name prefixes of local MCP servers whose tools are restored, e.g. `mcp__plugin_ops_ops__`. */
  readonly trustedPrefixes?: readonly string[];
}

// "mcp__<server>__": the closing "__" keeps "mcp__ops__" from also trusting "mcp__opsx__".
const MCP_PREFIX = /^mcp__.+__$/u;
// claude.ai connectors are called from Anthropic's side, so real values in their arguments would
// leave the machine.
const CONNECTOR_PREFIX = 'mcp__claude_ai_';

function assertTrustedPrefix(prefix: string): void {
  if (!MCP_PREFIX.test(prefix)) {
    throw new Error(`trusted MCP prefix "${prefix}" must start with "mcp__" and end with "__"`);
  }
  if (prefix.startsWith(CONNECTOR_PREFIX)) {
    throw new Error(
      `trusted MCP prefix "${prefix}" names a claude.ai connector, which runs remotely`,
    );
  }
}

/**
 * Whether a tool runs on this machine, so its arguments may carry real values. One rule for every
 * restorer, so a streamed reply and a whole one never disagree. Throws on an unsafe prefix.
 */
export function trustRule(options: TrustOptions = {}): (name: string) => boolean {
  const prefixes = options.trustedPrefixes ?? [];
  prefixes.forEach(assertTrustedPrefix);
  const tools = new Set(options.trustedTools ?? DEFAULT_TRUSTED_TOOLS);
  return (name) => tools.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
}
