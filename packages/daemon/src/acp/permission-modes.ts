// Labels for the runtime-owned ACP `mode` values shown in session-control surfaces
// (Slack status modal, Telegram/Discord select cards, `/permission` text lists).
// Copied verbatim from codex-acp's own AgentMode names so these surfaces read the same
// as the console, which renders the names the runtime reports in its catalog.
const CODEX_MODE_LABELS: Record<string, string> = {
  'read-only': 'Ask for approval', // always asks before editing external files or using the network
  agent: 'Approve for me', // only asks for actions the runtime's own reviewer flags as unsafe
  'agent-full-access': 'Full access'
}

/** Codex's own name for a mode; unknown values (Claude's `default`/`plan`) pass through. */
export function permissionModeDisplayLabel(value: string): string {
  return CODEX_MODE_LABELS[value] ?? value
}
