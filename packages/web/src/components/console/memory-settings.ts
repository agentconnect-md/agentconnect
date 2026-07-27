import type { AgentMemoryConfig, MemoryDreamingConfig } from '@/lib/api'
import { isIanaTimezone, isValidCron } from '@/lib/cron'
import {
  DEFAULT_EXTERNAL_MEMORY_BINDING,
  type ExternalMemoryBindingDraft
} from '@/components/console/ExternalMemoryBindingFields'

/**
 * Managed-only dreaming policy as a form draft. It carries the COMPLETE policy —
 * including fields the console doesn't yet edit (`sessionWindow`, `timezone`, and
 * the later-phase `mineSkills`) — because a managed-memory save PATCHes the
 * `memory` binding wholesale, so anything the draft drops is lost. The UI edits
 * `enabled`, `schedule`, `autoAdopt`, and `instructions`; the rest is preserved
 * verbatim from whatever the API (or a later phase) set.
 */
export interface DreamingDraft {
  enabled: boolean
  instructions: string
  autoAdopt: boolean
  sessionWindow?: number
  schedule?: string
  timezone?: string
  mineSkills?: boolean
}

/** Managed memory dreams daily at 04:00 in the daemon host's timezone and
 * accepts safe results automatically unless the user opts out. */
export const DEFAULT_DREAMING_DRAFT: DreamingDraft = {
  enabled: true,
  instructions: '',
  schedule: '0 4 * * *',
  autoAdopt: true
}

export type MemoryProviderChoice = 'managed' | 'native' | 'external' | 'none'

export const MEMORY_PROVIDER_OPTIONS: ReadonlyArray<{
  value: MemoryProviderChoice
  label: string
  separated?: boolean
}> = [
  { value: 'managed', label: 'Managed' },
  { value: 'native', label: 'Native' },
  { value: 'external', label: 'External' },
  { value: 'none', label: 'Off', separated: true }
]

export interface MemorySettingsDraft {
  provider: MemoryProviderChoice
  autoDistill: boolean
  dreaming: DreamingDraft
  external: ExternalMemoryBindingDraft
}

export function memoryProviderChoice(value: string): MemoryProviderChoice {
  return value === 'native' || value === 'external' || value === 'none' ? value : 'managed'
}

export function memoryProviderLabel(value: MemoryProviderChoice): string {
  return MEMORY_PROVIDER_OPTIONS.find((option) => option.value === value)?.label ?? 'Managed'
}

export function cloneMemorySettings(value: MemorySettingsDraft): MemorySettingsDraft {
  return {
    ...value,
    dreaming: { ...value.dreaming },
    external: { ...value.external, recall: { ...value.external.recall } }
  }
}

function sameDreaming(a: DreamingDraft, b: DreamingDraft): boolean {
  return (
    a.enabled === b.enabled &&
    a.instructions === b.instructions &&
    a.sessionWindow === b.sessionWindow &&
    a.schedule === b.schedule &&
    a.timezone === b.timezone &&
    a.mineSkills === b.mineSkills &&
    a.autoAdopt === b.autoAdopt
  )
}

export function memorySettingsDraft(input: {
  provider: string
  autoDistill: boolean
  dreaming?: MemoryDreamingConfig | null
  connectionId?: string
  recall?: ExternalMemoryBindingDraft['recall']
  captureMode?: ExternalMemoryBindingDraft['captureMode']
}): MemorySettingsDraft {
  return {
    provider: memoryProviderChoice(input.provider),
    autoDistill: input.autoDistill,
    dreaming: input.dreaming
      ? {
          enabled: input.dreaming.enabled,
          instructions: input.dreaming.instructions ?? '',
          autoAdopt: input.dreaming.autoAdopt ?? true,
          ...(input.dreaming.sessionWindow !== undefined ? { sessionWindow: input.dreaming.sessionWindow } : {}),
          ...(input.dreaming.schedule ? { schedule: input.dreaming.schedule } : {}),
          ...(input.dreaming.timezone ? { timezone: input.dreaming.timezone } : {}),
          ...(input.dreaming.mineSkills !== undefined ? { mineSkills: input.dreaming.mineSkills } : {})
        }
      : { ...DEFAULT_DREAMING_DRAFT },
    external: {
      ...DEFAULT_EXTERNAL_MEMORY_BINDING,
      recall: { ...DEFAULT_EXTERNAL_MEMORY_BINDING.recall },
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.recall ? { recall: { ...input.recall } } : {}),
      ...(input.captureMode ? { captureMode: input.captureMode } : {})
    }
  }
}

function sameExternalSettings(a: ExternalMemoryBindingDraft, b: ExternalMemoryBindingDraft): boolean {
  return (
    a.connectionId === b.connectionId &&
    a.captureMode === b.captureMode &&
    a.recall.mode === b.recall.mode &&
    a.recall.topK === b.recall.topK &&
    a.recall.maxBytes === b.recall.maxBytes &&
    a.recall.timeoutMs === b.recall.timeoutMs
  )
}

export function memorySettingsChanged(persisted: MemorySettingsDraft, draft: MemorySettingsDraft): boolean {
  if (persisted.provider !== draft.provider) return true
  if (draft.provider === 'managed') {
    return persisted.autoDistill !== draft.autoDistill || !sameDreaming(persisted.dreaming, draft.dreaming)
  }
  if (draft.provider === 'external') return !sameExternalSettings(persisted.external, draft.external)
  return false
}

export function memoryBackendChanged(persisted: MemorySettingsDraft, draft: MemorySettingsDraft): boolean {
  if (persisted.provider !== draft.provider) return true
  return draft.provider === 'external' && persisted.external.connectionId !== draft.external.connectionId
}

/**
 * Why a managed dreaming schedule can't be saved, or null.
 *
 * The wire schema only bounds these as strings, and the daemon's DreamScheduler
 * CATCHES the Croner error and skips installing the job — so an invalid cron or
 * timezone saves "successfully" and then silently never fires. The console is
 * the only place that can tell the user, so it has to refuse the save.
 */
export function dreamingScheduleBlocker(draft: DreamingDraft): string | null {
  const schedule = draft.schedule?.trim() ?? ''
  if (!draft.enabled || !schedule) return null // manual-only: nothing to validate
  // Croner, not cronstrue — the daemon installs the job with Croner, and the
  // two parsers disagree (cronstrue accepts e.g. `*/0 * * * *`, Croner throws).
  if (!isValidCron(schedule)) return 'That dreaming schedule is not a valid cron expression.'
  const timezone = draft.timezone?.trim() ?? ''
  // Empty is legitimate — it means "the daemon host's zone".
  if (timezone && !isIanaTimezone(timezone)) {
    return 'That dreaming timezone is not a known IANA timezone (for example America/New_York).'
  }
  return null
}

export function memorySettingsBlocker(draft: MemorySettingsDraft): string | null {
  if (draft.provider === 'external' && !draft.external.connectionId) {
    return 'Choose an external-memory connection before saving.'
  }
  if (draft.provider === 'managed') return dreamingScheduleBlocker(draft.dreaming)
  return null
}

export function memoryConfigForDraft(draft: MemorySettingsDraft): AgentMemoryConfig {
  if (draft.provider === 'external') {
    if (!draft.external.connectionId) throw new Error('external-memory connection is required')
    return {
      provider: 'external',
      connectionId: draft.external.connectionId,
      recall: draft.external.recall,
      capture: { mode: draft.external.captureMode }
    }
  }
  if (draft.provider === 'managed') {
    const dreaming = dreamingConfigForDraft(draft.dreaming)
    return { provider: 'managed', autoDistill: draft.autoDistill, ...(dreaming ? { dreaming } : {}) }
  }
  return { provider: draft.provider, autoDistill: false }
}

/** Map the dreaming form back to the wire policy, preserving every preserved
 *  field. When a policy differs from the defaults, `autoAdopt` is explicit so
 *  false remains a durable opt-out. */
export function dreamingConfigForDraft(draft: DreamingDraft): MemoryDreamingConfig | undefined {
  const instructions = draft.instructions.trim()
  const schedule = draft.schedule?.trim()
  const hasAny =
    draft.enabled !== DEFAULT_DREAMING_DRAFT.enabled ||
    !!instructions ||
    schedule !== DEFAULT_DREAMING_DRAFT.schedule ||
    !!draft.timezone ||
    draft.sessionWindow !== undefined ||
    draft.mineSkills !== undefined ||
    draft.autoAdopt !== DEFAULT_DREAMING_DRAFT.autoAdopt
  if (!hasAny) return undefined
  return {
    enabled: draft.enabled,
    ...(draft.sessionWindow !== undefined ? { sessionWindow: draft.sessionWindow } : {}),
    ...(schedule ? { schedule } : {}),
    ...(draft.timezone ? { timezone: draft.timezone } : {}),
    ...(instructions ? { instructions } : {}),
    ...(draft.mineSkills !== undefined ? { mineSkills: draft.mineSkills } : {}),
    autoAdopt: draft.autoAdopt
  }
}
