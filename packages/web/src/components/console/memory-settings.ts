import type { AgentMemoryConfig } from '@/lib/api'
import {
  DEFAULT_EXTERNAL_MEMORY_BINDING,
  type ExternalMemoryBindingDraft
} from '@/components/console/ExternalMemoryBindingFields'

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
    external: { ...value.external, recall: { ...value.external.recall } }
  }
}

export function memorySettingsDraft(input: {
  provider: string
  autoDistill: boolean
  connectionId?: string
  recall?: ExternalMemoryBindingDraft['recall']
  captureMode?: ExternalMemoryBindingDraft['captureMode']
}): MemorySettingsDraft {
  return {
    provider: memoryProviderChoice(input.provider),
    autoDistill: input.autoDistill,
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
  if (draft.provider === 'managed') return persisted.autoDistill !== draft.autoDistill
  if (draft.provider === 'external') return !sameExternalSettings(persisted.external, draft.external)
  return false
}

export function memoryBackendChanged(persisted: MemorySettingsDraft, draft: MemorySettingsDraft): boolean {
  if (persisted.provider !== draft.provider) return true
  return draft.provider === 'external' && persisted.external.connectionId !== draft.external.connectionId
}

export function memorySettingsBlocker(draft: MemorySettingsDraft): string | null {
  return draft.provider === 'external' && !draft.external.connectionId
    ? 'Choose an external-memory connection before saving.'
    : null
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
  if (draft.provider === 'managed') return { provider: 'managed', autoDistill: draft.autoDistill }
  return { provider: draft.provider, autoDistill: false }
}
