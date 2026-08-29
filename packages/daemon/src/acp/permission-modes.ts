// Labels for the runtime-owned ACP `mode` values shown in session-control surfaces
// (Slack status modal, Telegram/Discord select cards, `/permission` text lists).
const CODEX_MODE_LABELS: Record<string, string> = {
  'read-only': 'Read Only', // the daemon's permission profile keeps this sandbox read-only
  agent: 'Approve for me', // on-request approvals, reviewed by codex-acp's own reviewer
  'agent-full-access': 'Full Access'
}

/** Codex's own name for a mode; unknown values (Claude's `default`/`plan`) pass through. */
export function permissionModeDisplayLabel(value: string): string {
  return CODEX_MODE_LABELS[value] ?? value
}
