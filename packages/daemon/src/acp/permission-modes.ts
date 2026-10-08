// Codex ACP mode names shown in platform controls when the runtime reports only IDs.
const CODEX_MODE_LABELS: Record<string, string> = {
  'read-only': 'Read-only',
  'workspace-write': 'Workspace access',
  agent: 'Auto review',
  'agent-full-access': 'Full access'
}

/** Codex's own name for a mode; unknown values (Claude's `default`/`plan`) pass through. */
export function permissionModeDisplayLabel(value: string): string {
  return CODEX_MODE_LABELS[value] ?? value
}
