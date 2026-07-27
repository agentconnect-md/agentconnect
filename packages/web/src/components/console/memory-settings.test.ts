import { describe, expect, it } from 'vitest'
import { cronHuman, isValidCron } from '@/lib/cron'
import {
  MEMORY_PROVIDER_OPTIONS,
  dreamingScheduleBlocker,
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
    // The absent managed-memory policy is the daily auto-accepting product
    // default, so it remains compact on the wire.
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

  it('models daily dreaming and automatic acceptance as managed-memory defaults with durable opt-outs', () => {
    const defaults = memorySettingsDraft({ provider: 'managed', autoDistill: false })
    expect(defaults.dreaming).toEqual({
      enabled: true,
      instructions: '',
      schedule: '0 4 * * *',
      autoAdopt: true
    })
    expect(memoryConfigForDraft(defaults)).toEqual({ provider: 'managed', autoDistill: false })
    expect(dreamingConfigForDraft(defaults.dreaming)).toBeUndefined()

    const manualReview = {
      ...defaults,
      dreaming: { ...defaults.dreaming, schedule: undefined, autoAdopt: false }
    }
    expect(memorySettingsChanged(defaults, manualReview)).toBe(true)
    expect(memoryConfigForDraft(manualReview)).toEqual({
      provider: 'managed',
      autoDistill: false,
      dreaming: { enabled: true, autoAdopt: false }
    })

    const disabled = { ...defaults, dreaming: { ...defaults.dreaming, enabled: false } }
    expect(memoryConfigForDraft(disabled)).toEqual({
      provider: 'managed',
      autoDistill: false,
      dreaming: { enabled: false, schedule: '0 4 * * *', autoAdopt: true }
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

describe('dreaming schedule validation gates the save', () => {
  const managed = (dreaming: Partial<Record<string, unknown>>) =>
    memorySettingsDraft({
      provider: 'managed',
      autoDistill: false,
      dreaming: { enabled: true, ...dreaming } as never
    })

  it('refuses an invalid cron, which the daemon would accept and then never fire', () => {
    // The wire schema bounds `schedule` as a string and DreamScheduler swallows
    // the Croner error — so if the console saves this, the agent is silently
    // left unscheduled with no feedback anywhere.
    const draft = managed({ schedule: 'not a cron' })
    expect(dreamingScheduleBlocker(draft.dreaming)).toMatch(/not a valid cron/)
    expect(memorySettingsBlocker(draft)).toMatch(/not a valid cron/)
  })

  it('refuses an expression the two cron parsers disagree about', () => {
    // The daemon installs with Croner; cronstrue is more permissive. A zero step
    // reads as "Every 0 minutes" to cronstrue but Croner throws
    // `illegal stepping: 0`, so validating with the display parser would let
    // through exactly the never-fires config this blocker exists to stop.
    const zeroStep = '*/0 * * * *'
    expect(cronHuman(zeroStep)).not.toBeNull() // cronstrue happily reads it
    expect(isValidCron(zeroStep)).toBe(false) // Croner — the one that matters
    expect(memorySettingsBlocker(managed({ schedule: zeroStep }))).toMatch(/not a valid cron/)
  })

  it('refuses a timezone that is not a real IANA zone', () => {
    const draft = managed({ schedule: '0 4 * * *', timezone: 'Pacific/Nowhere' })
    expect(memorySettingsBlocker(draft)).toMatch(/IANA timezone/)
  })

  it('allows a valid schedule, and an empty timezone (the daemon host’s zone)', () => {
    expect(memorySettingsBlocker(managed({ schedule: '0 4 * * *', timezone: 'America/New_York' }))).toBeNull()
    expect(memorySettingsBlocker(managed({ schedule: '0 4 * * *' }))).toBeNull()
  })

  it('does not validate a schedule that is not in play', () => {
    // Manual-only, and dreaming-off with a leftover expression: nothing fires,
    // so nothing to block.
    expect(memorySettingsBlocker(managed({}))).toBeNull()
    const off = memorySettingsDraft({
      provider: 'managed',
      autoDistill: false,
      dreaming: { enabled: false, schedule: 'not a cron' } as never
    })
    expect(memorySettingsBlocker(off)).toBeNull()
  })
})
