import type { AgentMemoryConfig, ManagedMemoryScope, MemoryDreamingConfig } from '@/lib/api'
import { isIanaTimezone, isValidCron } from '@/lib/cron'
import {
  DEFAULT_EXTERNAL_MEMORY_BINDING,
  type ExternalMemoryBindingDraft
} from '@/components/console/ExternalMemoryBindingFields'

/**
 * Managed-only dreaming policy as a form draft. It carries the COMPLETE policy —
 * including fields the console doesn't yet edit (`sessionWindow`) — because a
 * managed-memory save PATCHes the `memory` binding wholesale, so anything the
 * draft drops is lost. The UI edits `enabled`, `schedule`, `timezone`,
 * `mineSkills`, `autoAdopt`, and `instructions`; the rest is preserved verbatim
 * from whatever the API (or a later phase) set.
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

/** Managed memory dreams daily at 04:00 in the daemon host's timezone. By default
 * completed dreams are adopted without review and reusable procedures are mined
 * into candidate skills (mined skills still need explicit approval to install). */
export const DEFAULT_DREAMING_DRAFT: DreamingDraft = {
  enabled: true,
  instructions: '',
  schedule: '0 4 * * *',
  autoAdopt: true,
  mineSkills: true
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
  /** Managed partitioning (#653). `channel` gives each channel its own memory and
   *  disables dreaming (offline consolidation doesn't map onto per-channel folders). */
  scope: ManagedMemoryScope
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
  scope?: ManagedMemoryScope
  dreaming?: MemoryDreamingConfig | null
  connectionId?: string
  recall?: ExternalMemoryBindingDraft['recall']
  captureMode?: ExternalMemoryBindingDraft['captureMode']
}): MemorySettingsDraft {
  return {
    provider: memoryProviderChoice(input.provider),
    autoDistill: input.autoDistill,
    scope: input.scope === 'channel' ? 'channel' : 'agent',
    dreaming: input.dreaming
      ? {
          enabled: input.dreaming.enabled,
          instructions: input.dreaming.instructions ?? '',
          autoAdopt: input.dreaming.autoAdopt ?? true,
          ...(input.dreaming.sessionWindow !== undefined ? { sessionWindow: input.dreaming.sessionWindow } : {}),
          ...(input.dreaming.schedule ? { schedule: input.dreaming.schedule } : {}),
          ...(input.dreaming.timezone ? { timezone: input.dreaming.timezone } : {}),
          mineSkills: input.dreaming.mineSkills ?? true
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
    if (persisted.scope !== draft.scope) return true
    // Under channel scope dreaming is hidden/disabled, so its draft fields don't count.
    if (draft.scope === 'channel') return persisted.autoDistill !== draft.autoDistill
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
  if (draft.provider === 'managed') {
    // Channel scope has no dreaming, so a stale (hidden) dreaming draft must not
    // block the save — mirror memoryConfigForDraft, which drops it entirely.
    return draft.scope === 'channel' ? null : dreamingScheduleBlocker(draft.dreaming)
  }
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
    // Channel scope has no dreaming (offline consolidation doesn't map onto
    // per-channel folders), so never serialize a dreaming policy with it.
    if (draft.scope === 'channel') {
      return { provider: 'managed', autoDistill: draft.autoDistill, scope: 'channel' }
    }
    const dreaming = dreamingConfigForDraft(draft.dreaming)
    return { provider: 'managed', autoDistill: draft.autoDistill, ...(dreaming ? { dreaming } : {}) }
  }
  return { provider: draft.provider, autoDistill: false }
}

/** Map the dreaming form back to the wire policy, preserving every preserved
 *  field. When a policy differs from the defaults, `autoAdopt` is explicit so
 *  true remains a durable opt-in. */
export function dreamingConfigForDraft(draft: DreamingDraft): MemoryDreamingConfig | undefined {
  const instructions = draft.instructions.trim()
  const schedule = draft.schedule?.trim()
  const hasAny =
    draft.enabled !== DEFAULT_DREAMING_DRAFT.enabled ||
    !!instructions ||
    schedule !== DEFAULT_DREAMING_DRAFT.schedule ||
    !!draft.timezone ||
    draft.sessionWindow !== undefined ||
    (draft.mineSkills ?? DEFAULT_DREAMING_DRAFT.mineSkills) !== DEFAULT_DREAMING_DRAFT.mineSkills ||
    draft.autoAdopt !== DEFAULT_DREAMING_DRAFT.autoAdopt
  if (!hasAny) return undefined
  return {
    enabled: draft.enabled,
    ...(draft.sessionWindow !== undefined ? { sessionWindow: draft.sessionWindow } : {}),
    ...(schedule ? { schedule } : {}),
    ...(draft.timezone ? { timezone: draft.timezone } : {}),
    ...(instructions ? { instructions } : {}),
    mineSkills: draft.mineSkills ?? DEFAULT_DREAMING_DRAFT.mineSkills,
    autoAdopt: draft.autoAdopt
  }
}
