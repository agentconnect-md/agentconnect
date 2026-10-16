import { describe, expect, it } from 'vitest'
import {
  AssistantModeAdmissionRefused,
  assertAssistantModeDefinition,
  assistantModeEditNeedsAdmission,
  assistantModePermissionModeForEdit,
  assistantModeStoreRefusals,
  StoredAssistantModePolicyRow
} from './assistant-mode.js'

const ON = { enabled: true }
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
    expect(() => assertAssistantModeDefinition({ runtime: 'codex-acp', memory: null })).not.toThrow()
    expect(() =>
      assertAssistantModeDefinition({ runtime: 'opencode', memory: { provider: 'managed', home: 'daemon' } })
    ).not.toThrow()
    try {
      assertAssistantModeDefinition({ runtime: 'qwen-code', memory: { provider: 'native' } })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(AssistantModeAdmissionRefused)
      expect((e as AssistantModeAdmissionRefused).refusals).toEqual(['runtime-not-admitted', 'memory-provider'])
      expect((e as Error).message).toMatch(/^assistant mode cannot be turned on: .*memory must be managed$/)
    }
  })

  it('tells an edit to an agent already in the mode to turn it off first', () => {
    expect(() => assertAssistantModeDefinition({ runtime: 'claude-acp', memory: { provider: 'none' } }, true)).toThrow(
      'assistant mode is on, so this edit is refused: memory must be managed; turn assistant mode off first'
    )
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

describe('assistant mode permission default', () => {
  const claude = (permissionMode: string | null) => ({ runtime: 'claude-acp', permissionMode })

  it('applies only on the edit that turns it on', () => {
    expect(assistantModePermissionModeForEdit(undefined, ON, claude('default'), false)).toBe('auto')
    expect(assistantModePermissionModeForEdit(OFF, ON, claude(null), false)).toBe('auto')
    expect(assistantModePermissionModeForEdit(ON, { ...ON, instructions: 'x' }, claude('default'), false)).toBe(
      undefined
    )
    expect(assistantModePermissionModeForEdit(OFF, OFF, claude('default'), false)).toBeUndefined()
    expect(assistantModePermissionModeForEdit(ON, null, claude('default'), false)).toBeUndefined()
  })

  it('leaves a mode set in the same edit, and one that already runs unattended', () => {
    expect(assistantModePermissionModeForEdit(OFF, ON, claude('default'), true)).toBeUndefined()
    expect(assistantModePermissionModeForEdit(OFF, ON, claude('bypassPermissions'), false)).toBeUndefined()
    expect(
      assistantModePermissionModeForEdit(OFF, ON, { runtime: 'codex-acp', permissionMode: 'read-only' }, false)
    ).toBe('agent')
    expect(assistantModePermissionModeForEdit(OFF, ON, { runtime: 'opencode', permissionMode: 'plan' }, false)).toBe(
      undefined
    )
  })
})

describe('a stored assistant mode policy', () => {
  it('keeps the routing keys an older CP wrote and drops a removed key instead of failing the read', () => {
    const stored = {
      enabled: true,
      responsibleUserId: 'usr_1',
      patrolSchedule: '0 9 * * *',
      limits: { dailyCheckBudget: 5, dailySubsessionsPerItem: 3 }
    }
    expect(StoredAssistantModePolicyRow.parse(stored)).toEqual({
      enabled: true,
      responsibleUserId: 'usr_1',
      limits: { dailyCheckBudget: 5 }
    })
  })
})
