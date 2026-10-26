// What a capability request's page says changes is read from what was asked against the agent's current values.
import { describe, expect, it } from 'vitest'
import {
  askedBy,
  askerName,
  capabilityDiff,
  capabilityProviderId,
  grantNamesRepository,
  splitSkillRef
} from './capability-requests'

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

describe('the Phase 2 kinds', () => {
  it('reads a repository request against the tier the agent holds', () => {
    expect(
      capabilityDiff({
        kind: 'repository',
        want: { provider: 'github', repository: 'acme/widgets', access: 'write' },
        current: { authorized: 'read' }
      })
    ).toEqual([{ kind: 'repository', provider: 'github', repository: 'acme/widgets', from: 'read', to: 'write' }])
    expect(
      capabilityDiff({
        kind: 'repository',
        want: { provider: 'gitlab', repository: 'g/p', access: 'read' },
        current: {}
      })[0]
    ).toMatchObject({ from: 'none' })
  })

  it('says whether a connection already holds and where a header goes', () => {
    expect(
      capabilityDiff({
        kind: 'connection',
        want: { type: 'mcp-oauth', server: 'Linear' },
        current: { connected: true }
      })
    ).toEqual([{ kind: 'connection', connection: { type: 'mcp-oauth', server: 'Linear' }, connected: true }])
    expect(
      capabilityDiff({
        kind: 'secret',
        want: { name: 'X-Api-Key', description: 'key', use: { route: 'mcp-header', server: 'Grafana' } },
        current: { present: false }
      })
    ).toEqual([
      { kind: 'secret', name: 'X-Api-Key', description: 'key', route: 'mcp-header', server: 'Grafana', present: false }
    ])
  })

  it('finds the provider from the request, else from the completion hint', () => {
    expect(capabilityProviderId({ current: { providerId: 'p-1' }, completion: { providerId: 'p-2' } })).toBe('p-1')
    expect(capabilityProviderId({ current: {}, completion: { providerId: 'p-2' } })).toBe('p-2')
    expect(capabilityProviderId({ current: {}, completion: null })).toBeNull()
  })

  it('matches a grant to a repository the way the code host does', () => {
    const want = { provider: 'github' as const, repository: 'acme/widgets' }
    expect(grantNamesRepository({ repoFullName: 'Acme/Widgets' }, want)).toBe(true)
    expect(grantNamesRepository({ repoFullName: 'acme/widgets', provider: 'gitlab' }, want)).toBe(false)
  })
})
