// The review/reporting vocabulary both code hosts share: the two effect enums, the capability
// projection, and the preset row. Whatever only one host has stays in that host's own module.

export type HookReviewPolicy = 'off' | 'comment' | 'request_changes' | 'full'
export type HookReportingMode = 'off' | 'check'
export type HookGateMode = 'informational'

export interface CodeHostReviewSettingsValue {
  reviewPolicy: HookReviewPolicy
  reportingMode: HookReportingMode
}

export interface CodeHostReviewCapabilities {
  inlineComments: boolean
  requestChanges: boolean
  approve: boolean
  statusCheck: boolean
}

/** Present the hierarchical reviewPolicy enum as capability checkboxes. */
export function codeHostReviewCapabilities(value: CodeHostReviewSettingsValue): CodeHostReviewCapabilities {
  return {
    inlineComments: value.reviewPolicy !== 'off',
    requestChanges: value.reviewPolicy === 'request_changes' || value.reviewPolicy === 'full',
    approve: value.reviewPolicy === 'full',
    statusCheck: value.reportingMode === 'check'
  }
}

/** Collapse capability checkboxes back to the strongest enabled policy. */
export function codeHostReviewSettingsFromCapabilities(
  capabilities: CodeHostReviewCapabilities
): CodeHostReviewSettingsValue {
  return {
    reviewPolicy: capabilities.approve
      ? 'full'
      : capabilities.requestChanges
        ? 'request_changes'
        : capabilities.inlineComments
          ? 'comment'
          : 'off',
    reportingMode: capabilities.statusCheck ? 'check' : 'off'
  }
}

/** The three presets the disclosure opens on, in display order. */
export const REVIEW_PRESETS = [
  { id: 'none', label: 'None', value: { reviewPolicy: 'off', reportingMode: 'off' } },
  { id: 'brief', label: 'Brief', value: { reviewPolicy: 'comment', reportingMode: 'off' } },
  { id: 'details', label: 'Details', value: { reviewPolicy: 'full', reportingMode: 'check' } }
] as const satisfies ReadonlyArray<{ id: string; label: string; value: CodeHostReviewSettingsValue }>

export type ReviewPresetId = (typeof REVIEW_PRESETS)[number]['id']

/** The create surfaces' format row. `None` is not a tile there: turning every
 *  Custom capability off IS the no-review state, and one fewer way to say the
 *  same thing. Custom is a DISCLOSURE, not a value — it reveals the capability
 *  checkboxes and leaves the current value alone until one is clicked. */
export const REVIEW_FORMATS = [
  { id: 'brief', label: 'Brief' },
  { id: 'details', label: 'Details' },
  { id: 'custom', label: 'Custom' }
] as const satisfies ReadonlyArray<{ id: string; label: string }>

export type ReviewFormatId = (typeof REVIEW_FORMATS)[number]['id']

/** The format row's default: the full set — inline comments, request changes, approve, status check. */
export const REVIEW_FORMAT_DEFAULT: CodeHostReviewSettingsValue = { reviewPolicy: 'full', reportingMode: 'check' }

/** Which format tile a value reads as — anything but an exact Brief or Details is custom. */
export function reviewFormatOf(value: CodeHostReviewSettingsValue): ReviewFormatId {
  const exact = REVIEW_PRESETS.find(
    (preset) => preset.value.reviewPolicy === value.reviewPolicy && preset.value.reportingMode === value.reportingMode
  )
  return exact?.id === 'brief' || exact?.id === 'details' ? exact.id : 'custom'
}

/** The value a format tile applies; `custom` applies none. */
export function reviewFormatValue(id: ReviewFormatId): CodeHostReviewSettingsValue | null {
  return REVIEW_PRESETS.find((preset) => preset.id === id)?.value ?? null
}

/** Which preset a stored value reads as; anything richer than "brief" is details. */
export function reviewPresetOf(value: CodeHostReviewSettingsValue): ReviewPresetId {
  if (value.reviewPolicy === 'off' && value.reportingMode === 'off') return 'none'
  return value.reviewPolicy === 'comment' && value.reportingMode === 'off' ? 'brief' : 'details'
}

/** Apply one capability checkbox with its dependants, so a click never leaves an impossible tuple. */
export function withCapability(
  capabilities: CodeHostReviewCapabilities,
  key: keyof CodeHostReviewCapabilities,
  enabled: boolean
): CodeHostReviewCapabilities {
  const next = { ...capabilities, [key]: enabled }
  if (key === 'inlineComments' && !enabled) {
    next.requestChanges = false
    next.approve = false
  } else if (key === 'requestChanges') {
    if (enabled) next.inlineComments = true
    else next.approve = false
  } else if (key === 'approve' && enabled) {
    next.inlineComments = true
    next.requestChanges = true
  }
  return next
}

export const REVIEW_POLICY_OPTIONS: ReadonlyArray<{
  value: HookReviewPolicy
  label: string
  description: string
}> = [
  { value: 'off', label: 'Off', description: 'Do not submit a formal review.' },
  { value: 'comment', label: 'Comment', description: 'Submit a formal COMMENT review.' },
  {
    value: 'request_changes',
    label: 'Request changes',
    description: 'Allow COMMENT or REQUEST_CHANGES.'
  },
  { value: 'full', label: 'Full', description: 'Also allow an approval.' }
]

export function reviewPolicyLabel(policy: HookReviewPolicy): string {
  return REVIEW_POLICY_OPTIONS.find((option) => option.value === policy)?.label ?? 'Off'
}
