/**
 * Display labels for ACP permission/approval mode values shown to users (Slack
 * status modal, Telegram/Discord select cards, `/permission` text lists).
 *
 * The wire and ACP `session/set_config_option` calls always carry the raw,
 * runtime-owned value (`read-only` / `agent` / `agent-full-access` on codex-acp);
 * these labels are a presentation layer only. Values are mapped to the name Codex's
 * own UI ("Update Model Permissions", v0.144.x) gives that same approval+sandbox
 * preset — matched by policy, NOT by menu position — so we can't misrepresent them:
 *
 *   read-only         → "Read Only"          (approval on-request, read-only sandbox)
 *   agent             → "Ask for approval"   (on-request + workspace-write; Codex's default,
 *                                             its literal label for this preset)
 *   agent-full-access → "Full Access"        (danger-full-access: out-of-workspace + network)
 *
 * NB: Codex's CLI menu also offers "Approve for me" (on-failure — ask only on unsafe
 * actions), but codex-acp does not advertise a matching session mode, so it never
 * appears here. Unknown values (e.g. Claude's `default` / `plan`) fall through verbatim.
 */
const CODEX_MODE_LABELS: Record<string, string> = {
  'read-only': 'Read Only',
  agent: 'Ask for approval',
  'agent-full-access': 'Full Access'
}

export function permissionModeDisplayLabel(value: string): string {
  return CODEX_MODE_LABELS[value] ?? value
}
