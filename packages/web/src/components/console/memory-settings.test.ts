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
    expect(off.dreaming).toEqual({ enabled: false, instructions: '' })
    expect(memoryConfigForDraft(off)).toEqual({ provider: 'managed', autoDistill: false })
    expect(dreamingConfigForDraft(off.dreaming)).toBeUndefined()

    // Enabling and editing instructions is tracked as an unsaved change.
    const enabled = { ...off, dreaming: { enabled: true, instructions: 'focus on prefs' } }
    expect(memorySettingsChanged(off, enabled)).toBe(true)
    expect(memoryConfigForDraft(enabled)).toEqual({
      provider: 'managed',
      autoDistill: false,
      dreaming: { enabled: true, instructions: 'focus on prefs' }
    })
  })

  it('preserves the full dreaming policy across a save, even fields the console does not edit', () => {
    // A complete API-configured policy round-trips: the wholesale `memory` PATCH
    // must not drop sessionWindow / timezone / mineSkills / autoAdopt just because
    // the console only edits enabled + schedule + instructions.
    const full = memorySettingsDraft({
      provider: 'managed',
      autoDistill: true,
      dreaming: {
        enabled: true,
        sessionWindow: 40,
        schedule: '0 4 * * *',
        timezone: 'America/New_York',
        instructions: 'focus on prefs',
        mineSkills: true,
        autoAdopt: false
      }
    })
    expect(full.dreaming).toEqual({
      enabled: true,
      instructions: 'focus on prefs',
      sessionWindow: 40,
      schedule: '0 4 * * *',
      timezone: 'America/New_York',
      mineSkills: true,
      autoAdopt: false
    })
    // Editing only the instructions still re-emits every preserved field.
    const edited = { ...full, dreaming: { ...full.dreaming, instructions: 'new focus' } }
    expect(memoryConfigForDraft(edited)).toEqual({
      provider: 'managed',
      autoDistill: true,
      dreaming: {
        enabled: true,
        sessionWindow: 40,
        schedule: '0 4 * * *',
        timezone: 'America/New_York',
        instructions: 'new focus',
        mineSkills: true,
        autoAdopt: false
      }
    })

    // The schedule IS editable now that D-2b fires it; the edit round-trips.
    const rescheduled = { ...full, dreaming: { ...full.dreaming, schedule: '30 2 * * 0' } }
    expect(memorySettingsChanged(full, rescheduled)).toBe(true)
    expect(memoryConfigForDraft(rescheduled)).toMatchObject({
      dreaming: { schedule: '30 2 * * 0', timezone: 'America/New_York' }
    })
  })
})
