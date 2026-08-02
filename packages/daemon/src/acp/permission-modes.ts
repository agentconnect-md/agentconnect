/**
 * Display labels for ACP permission/approval mode values shown to users (Slack
 * status modal, Telegram/Discord select cards, `/permission` text lists).
 *
 * ACP `session/set_config_option` calls always carry the raw, runtime-owned mode
 * (`read-only` / `agent` / `agent-full-access` on codex-acp). AgentConnect's
 * session-control surfaces additionally use one synthetic preset for Auto-review;
 * it is decomposed back into the raw mode + reviewer at the AcpHost boundary.
 * Values are mapped to the name Codex's own UI ("Update Model Permissions",
 * v0.144.x) gives that same approval+sandbox preset — matched by policy, NOT by
 * menu position — so we can't misrepresent them:
 *
 *   read-only         → "Read Only"          (approval on-request, read-only sandbox)
 *   agent             → "Ask for approval"   (on-request + workspace-write; Codex's default,
 *                                             its literal label for this preset)
 *   agent-full-access → "Full Access"        (danger-full-access: out-of-workspace + network)
 *
 * Auto is not a fourth ACP mode: it is `agent` plus `_approvals_reviewer=auto_review`.
 * Unknown values (e.g. Claude's `default` / `plan`) fall through verbatim.
 */
export const AUTO_REVIEW_PERMISSION_PRESET = 'agent:auto-review'

export type SessionApprovalsReviewer = 'user' | 'auto_review'

const CODEX_MODE_LABELS: Record<string, string> = {
  'read-only': 'Read Only',
  agent: 'Ask for approval',
  [AUTO_REVIEW_PERMISSION_PRESET]: 'Auto',
  'agent-full-access': 'Full Access'
}

export function permissionModeDisplayLabel(value: string): string {
  return CODEX_MODE_LABELS[value] ?? value
}

/** Compose the two independent Codex settings into the value session selectors use. */
export function selectedPermissionPreset(
  permissionMode: string,
  approvalsReviewer: SessionApprovalsReviewer | undefined
): string {
  return permissionMode === 'agent' && approvalsReviewer === 'auto_review'
    ? AUTO_REVIEW_PERMISSION_PRESET
    : permissionMode
}

/** Decompose a session selector value before it reaches ACP. Selecting any ordinary
 * mode restores user review, so switching away from Auto cannot leave it enabled. */
export function permissionPresetSettings(preset: string): {
  permissionMode: string
  approvalsReviewer: SessionApprovalsReviewer
} {
  return preset === AUTO_REVIEW_PERMISSION_PRESET
    ? { permissionMode: 'agent', approvalsReviewer: 'auto_review' }
    : { permissionMode: preset, approvalsReviewer: 'user' }
}

/** Insert Auto after the ordinary Agent mode only when the live runtime advertises
 * both ingredients. Already-composed lists pass through unchanged. */
export function permissionPresetValues(
  permissionModes: readonly string[],
  approvalsReviewers: readonly string[]
): string[] {
  if (
    !permissionModes.includes('agent') ||
    permissionModes.includes(AUTO_REVIEW_PERMISSION_PRESET) ||
    !approvalsReviewers.includes('auto_review')
  ) {
    return [...permissionModes]
  }
  const agentIndex = permissionModes.indexOf('agent')
  return [
    ...permissionModes.slice(0, agentIndex + 1),
    AUTO_REVIEW_PERMISSION_PRESET,
    ...permissionModes.slice(agentIndex + 1)
  ]
}
