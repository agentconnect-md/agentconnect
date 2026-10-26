// Pure reads of a capability request for its page (capability-requests.md §4.5): what changes, and who asked.
import type { CapabilityRequestAskerDto, CapabilityRequestDto, CapabilitySettingsWant } from '@/lib/api'

/** The longest note a decline carries, as the server accepts it. */
export const CAPABILITY_NOTE_MAX = 500

export const CAPABILITY_SETTING_FIELDS = [
  'model',
  'reasoningEffort',
  'fastMode',
  'outputMode',
  'permissionMode'
] as const satisfies readonly (keyof CapabilitySettingsWant)[]

export type CapabilitySettingField = (typeof CAPABILITY_SETTING_FIELDS)[number]

/** One line of "What changes": a setting moving from its current value, or something added to the agent. */
export type CapabilityDiffLine =
  | { kind: 'setting'; field: CapabilitySettingField; from: string | boolean | null; to: string | boolean }
  | { kind: 'mcp-server'; server: string; already: boolean; exists: boolean }
  | { kind: 'skill'; skill: string; already: boolean }

/** A setting's value as the request page shows it; booleans and empties stay typed for the caller's wording. */
function settingValue(value: unknown): string | boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string' && value.length > 0) return value
  return null
}

export function capabilityDiff(request: Pick<CapabilityRequestDto, 'kind' | 'want' | 'current'>): CapabilityDiffLine[] {
  const { kind, want, current } = request
  if (kind === 'agent-settings') {
    const asked = want as CapabilitySettingsWant
    return CAPABILITY_SETTING_FIELDS.flatMap((field) => {
      const to = asked[field]
      if (to === undefined) return []
      return [{ kind: 'setting' as const, field, from: settingValue(current[field]), to }]
    })
  }
  if (kind === 'mcp-server') {
    const server = (want as { server: string }).server
    return [{ kind: 'mcp-server', server, already: current.attached === true, exists: current.exists !== false }]
  }
  return [{ kind: 'skill', skill: (want as { skill: string }).skill, already: current.installed === true }]
}

/** A skill reference `<source>/<skill>`: the library entry before the first slash, the skill after it. */
export function splitSkillRef(ref: string): { source: string; skill: string } {
  const slash = ref.indexOf('/')
  return slash < 0 ? { source: ref, skill: '' } : { source: ref.slice(0, slash), skill: ref.slice(slash + 1) }
}

/** The people the request is headed by: the first conversation's, as it asked (§4.3). */
export function askedBy(request: Pick<CapabilityRequestDto, 'origins'>): CapabilityRequestAskerDto[] {
  return request.origins[0]?.askers ?? []
}

/** How a person behind a conversation is named, falling back to their id when no name was recorded. */
export function askerName(asker: CapabilityRequestAskerDto): string {
  return asker.name?.trim() || asker.userId
}
