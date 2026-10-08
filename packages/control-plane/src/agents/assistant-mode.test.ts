import { describe, expect, it } from 'vitest'
import {
  AssistantModeAdmissionRefused,
  assertAssistantModeDefinition,
  assistantModeEditNeedsAdmission,
  assistantModeStoreRefusals
} from './assistant-mode.js'

const ON = { enabled: true, responsibleUserId: 'usr_1' }
const OFF = { enabled: false }

function sets(orgId: string | null, stores: Array<string | null>) {
  return {
    get: async (id: string) => ({ id, orgId, name: 'group', spreadSessions: false }),
    memberContentStoresOf: async () => stores
  }
}

describe('assistant mode admission edges', () => {
  it('checks an edit that turns it on, or changes the definition while it is on', () => {
    expect(assistantModeEditNeedsAdmission(undefined, ON, false)).toBe(true)
    expect(assistantModeEditNeedsAdmission(OFF, ON, false)).toBe(true)
    expect(assistantModeEditNeedsAdmission(ON, { ...ON, instructions: 'x' }, false)).toBe(false)
    expect(assistantModeEditNeedsAdmission(ON, ON, true)).toBe(true)
    expect(assistantModeEditNeedsAdmission(ON, OFF, true)).toBe(false)
    expect(assistantModeEditNeedsAdmission(ON, null, true)).toBe(false)
  })

  it('throws every definition refusal at once', () => {
    expect(() => assertAssistantModeDefinition({ runtime: 'claude-acp', memory: null })).not.toThrow()
    try {
      assertAssistantModeDefinition({ runtime: 'codex-acp', memory: { provider: 'native' } })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(AssistantModeAdmissionRefused)
      expect((e as AssistantModeAdmissionRefused).refusals).toEqual(['runtime-not-admitted', 'memory-provider'])
    }
  })

  it('needs one shared store across an org group, and nothing elsewhere', async () => {
    const placed = { placementKind: 'set' as const, setId: 'set-1' }
    expect(await assistantModeStoreRefusals(sets('org', ['s1', 's1']), placed)).toEqual([])
    expect(await assistantModeStoreRefusals(sets('org', ['s1', 's2']), placed)).toEqual(['store-not-shared'])
    expect(await assistantModeStoreRefusals(sets('org', [null, null]), placed)).toEqual(['store-not-shared'])
    expect(await assistantModeStoreRefusals(sets('org', []), placed)).toEqual([])
    expect(await assistantModeStoreRefusals(sets(null, [null, 's2']), placed)).toEqual([])
    expect(
      await assistantModeStoreRefusals(sets('org', ['s1', 's2']), { placementKind: 'daemon', setId: null })
    ).toEqual([])
  })
})
