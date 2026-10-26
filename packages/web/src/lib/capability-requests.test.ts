// What a capability request's page says changes is read from what was asked against the agent's current values.
import { describe, expect, it } from 'vitest'
import { askedBy, askerName, capabilityDiff, splitSkillRef } from './capability-requests'

describe('capabilityDiff', () => {
  it('lists each asked setting against its current value, in a fixed order', () => {
    const lines = capabilityDiff({
      kind: 'agent-settings',
      want: { permissionMode: 'bypassPermissions', model: 'opus', fastMode: true },
      current: { model: 'sonnet', permissionMode: 'default' }
    })
    expect(lines).toEqual([
      { kind: 'setting', field: 'model', from: 'sonnet', to: 'opus' },
      { kind: 'setting', field: 'fastMode', from: null, to: true },
      { kind: 'setting', field: 'permissionMode', from: 'default', to: 'bypassPermissions' }
    ])
  })

  it('says whether a server is already attached or registered at all', () => {
    expect(
      capabilityDiff({ kind: 'mcp-server', want: { server: 'Linear' }, current: { attached: false, exists: true } })
    ).toEqual([{ kind: 'mcp-server', server: 'Linear', already: false, exists: true }])
    expect(
      capabilityDiff({ kind: 'mcp-server', want: { server: 'Linear' }, current: { attached: false, exists: false } })
    ).toEqual([{ kind: 'mcp-server', server: 'Linear', already: false, exists: false }])
  })

  it('says whether a skill is already installed', () => {
    expect(capabilityDiff({ kind: 'skill', want: { skill: 'acme/lint' }, current: { installed: true } })).toEqual([
      { kind: 'skill', skill: 'acme/lint', already: true }
    ])
  })
})

describe('splitSkillRef', () => {
  it('splits at the first slash', () => {
    expect(splitSkillRef('acme/lint')).toEqual({ source: 'acme', skill: 'lint' })
    expect(splitSkillRef('acme/tools/lint')).toEqual({ source: 'acme', skill: 'tools/lint' })
  })
})

describe('askedBy', () => {
  it('heads the request with the first conversation’s people, named or by id', () => {
    const origin = (userId: string, name: string | null) => ({
      sessionId: userId,
      platform: 'slack',
      placeLabel: null,
      external: false,
      askers: [{ kind: 'member' as const, userId, name, platform: 'slack' }],
      nobody: false,
      askedAt: '2026-10-26T00:00:00.000Z',
      wake: 'none' as const,
      wakeReason: null
    })
    const people = askedBy({ origins: [origin('U1', 'Ana'), origin('U2', 'Bob')] })
    expect(people.map(askerName)).toEqual(['Ana'])
    expect(askedBy({ origins: [origin('U3', null)] }).map(askerName)).toEqual(['U3'])
    expect(askedBy({ origins: [] })).toEqual([])
  })
})
