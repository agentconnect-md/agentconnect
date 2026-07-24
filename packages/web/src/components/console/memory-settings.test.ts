import { describe, expect, it } from 'vitest'
import {
  MEMORY_PROVIDER_OPTIONS,
  dreamingConfigForDraft,
  memoryBackendChanged,
  memoryConfigForDraft,
  memorySettingsBlocker,
  memorySettingsChanged,
  memorySettingsDraft
} from './memory-settings'

const CONNECTION_A = '11111111-1111-4111-8111-111111111111'
const CONNECTION_B = '22222222-2222-4222-8222-222222222222'

describe('memory settings UX model', () => {
  it('orders storage backends first and presents the disabled mode as Off', () => {
    expect(MEMORY_PROVIDER_OPTIONS).toEqual([
      { value: 'managed', label: 'Managed' },
      { value: 'native', label: 'Native' },
      { value: 'external', label: 'External' },
      { value: 'none', label: 'Off', separated: true }
    ])
  })

  it('tracks every editable setting as an unsaved draft', () => {
    const managed = memorySettingsDraft({ provider: 'managed', autoDistill: false })
    expect(memorySettingsChanged(managed, managed)).toBe(false)
    expect(memorySettingsChanged(managed, { ...managed, autoDistill: true })).toBe(true)
    expect(memorySettingsChanged(managed, { ...managed, provider: 'native' })).toBe(true)

    const external = memorySettingsDraft({
      provider: 'external',
      autoDistill: false,
      connectionId: CONNECTION_A
    })
    expect(memorySettingsChanged(external, external)).toBe(false)
    expect(
      memorySettingsChanged(external, {
        ...external,
        external: { ...external.external, captureMode: 'turn' }
      })
    ).toBe(true)
    expect(
      memorySettingsChanged(external, {
        ...external,
        external: { ...external.external, recall: { ...external.external.recall, timeoutMs: 5000 } }
      })
    ).toBe(true)
  })

  it('requires a connection and distinguishes policy edits from backend switches', () => {
    const current = memorySettingsDraft({
      provider: 'external',
      autoDistill: false,
      connectionId: CONNECTION_A
    })
    const missing = { ...current, external: { ...current.external, connectionId: '' } }
    const policyEdit = {
      ...current,
      external: { ...current.external, recall: { ...current.external.recall, topK: 8 } }
    }
    const connectionSwitch = { ...current, external: { ...current.external, connectionId: CONNECTION_B } }

    expect(memorySettingsBlocker(missing)).toBe('Choose an external-memory connection before saving.')
    expect(() => memoryConfigForDraft(missing)).toThrow('external-memory connection is required')
    expect(memoryBackendChanged(current, policyEdit)).toBe(false)
    expect(memoryBackendChanged(current, connectionSwitch)).toBe(true)
  })

  it('builds the same guarded API shapes for every mode', () => {
    expect(memoryConfigForDraft(memorySettingsDraft({ provider: 'managed', autoDistill: true }))).toEqual({
      provider: 'managed',
      autoDistill: true
    })
    expect(memoryConfigForDraft(memorySettingsDraft({ provider: 'native', autoDistill: true }))).toEqual({
      provider: 'native',
      autoDistill: false
    })
    expect(memoryConfigForDraft(memorySettingsDraft({ provider: 'none', autoDistill: true }))).toEqual({
      provider: 'none',
      autoDistill: false
    })
    expect(
      memoryConfigForDraft(
        memorySettingsDraft({ provider: 'external', autoDistill: false, connectionId: CONNECTION_A })
      )
    ).toMatchObject({ provider: 'external', connectionId: CONNECTION_A })
  })

  it('models managed dreaming as an optional binding', () => {
    // Off by default: an untouched managed agent emits no `dreaming` binding.
    const off = memorySettingsDraft({ provider: 'managed', autoDistill: false })
    expect(off.dreaming).toEqual({ enabled: false, schedule: '', instructions: '' })
    expect(memoryConfigForDraft(off)).toEqual({ provider: 'managed', autoDistill: false })
    expect(dreamingConfigForDraft(off.dreaming)).toBeUndefined()

    // Enabling (and edits to schedule/instructions) are tracked as unsaved changes.
    const enabled = { ...off, dreaming: { enabled: true, schedule: '0 4 * * *', instructions: 'focus on prefs' } }
    expect(memorySettingsChanged(off, enabled)).toBe(true)
    expect(memoryConfigForDraft(enabled)).toEqual({
      provider: 'managed',
      autoDistill: false,
      dreaming: { enabled: true, schedule: '0 4 * * *', instructions: 'focus on prefs' }
    })

    // Round-trips from the wire config, and trims blank schedule/instructions out.
    const fromWire = memorySettingsDraft({
      provider: 'managed',
      autoDistill: true,
      dreaming: { enabled: true }
    })
    expect(fromWire.dreaming).toEqual({ enabled: true, schedule: '', instructions: '' })
    expect(memoryConfigForDraft(fromWire)).toEqual({
      provider: 'managed',
      autoDistill: true,
      dreaming: { enabled: true }
    })
  })
})
