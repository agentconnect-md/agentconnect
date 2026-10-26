import { describe, expect, it } from 'vitest'
import {
  CapabilityAsk,
  CapabilityRequestReq,
  SessionCapabilitySettled,
  capabilityTarget
} from './capability-request.js'

const AGENT = '7d1f3c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f'
const REQUEST = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9'

describe('capability request frames', () => {
  it('refuses unknown want fields instead of ignoring them', () => {
    expect(CapabilityAsk.safeParse({ kind: 'mcp-server', want: { server: 'Linear' } }).success).toBe(true)
    expect(CapabilityAsk.safeParse({ kind: 'mcp-server', want: { server: 'Linear', url: 'x' } }).success).toBe(false)
    expect(CapabilityAsk.safeParse({ kind: 'agent-settings', want: { workspace: 'x' } }).success).toBe(false)
    expect(CapabilityAsk.safeParse({ kind: 'agent-settings', want: {} }).success).toBe(false)
    expect(CapabilityAsk.safeParse({ kind: 'secret', want: { name: 'X' } }).success).toBe(false)
  })

  it('accepts a skill only as <source>/<skill>', () => {
    expect(CapabilityAsk.safeParse({ kind: 'skill', want: { skill: 'acme/tools/lint' } }).success).toBe(true)
    expect(CapabilityAsk.safeParse({ kind: 'skill', want: { skill: 'lint' } }).success).toBe(false)
  })

  it('keys settings requests by the sorted fields they ask for', () => {
    expect(capabilityTarget({ kind: 'agent-settings', want: { permissionMode: 'default', model: 'm' } })).toBe(
      'model+permissionMode'
    )
    expect(capabilityTarget({ kind: 'mcp-server', want: { server: 'Linear' } })).toBe('Linear')
    expect(capabilityTarget({ kind: 'skill', want: { skill: 'acme/lint' } })).toBe('acme/lint')
  })

  it('caps the reason and carries an explicit nobody', () => {
    const req = {
      agentId: AGENT,
      sessionId: 's-1',
      sessionKey: 'slack:C1:1.0',
      ask: { kind: 'mcp-server', want: { server: 'Linear' } },
      reason: 'filing the bug needs Linear',
      askers: { people: [], nobody: true },
      platform: 'slack'
    }
    expect(CapabilityRequestReq.safeParse(req).success).toBe(true)
    expect(CapabilityRequestReq.safeParse({ ...req, reason: 'x'.repeat(281) }).success).toBe(false)
  })

  it('names the generation and the origin askers on a settlement wake', () => {
    const wake = {
      agentId: AGENT,
      sessionId: 's-1',
      sessionKey: 'slack:C1:1.0',
      requestId: REQUEST,
      generation: 2,
      status: 'declined',
      askers: { people: [{ kind: 'member', platform: 'slack', integrationId: 'i-1', userId: 'U1' }], nobody: false },
      summary: 'add the MCP server "Linear"',
      reason: 'filing the bug needs Linear',
      outcome: '',
      by: { name: 'Ben' },
      note: 'We track bugs in GitHub issues.',
      reload: false
    }
    expect(SessionCapabilitySettled.safeParse(wake).success).toBe(true)
    expect(SessionCapabilitySettled.safeParse({ ...wake, generation: 0 }).success).toBe(false)
  })

  it('validates the Phase 2 kinds and keys them by what they name', () => {
    const repo = {
      kind: 'repository',
      want: { provider: 'github', repository: 'Acme/Widgets', access: 'write' }
    } as const
    expect(CapabilityAsk.safeParse(repo).success).toBe(true)
    expect(capabilityTarget(repo)).toBe('github::acme/widgets:write')
    expect(CapabilityAsk.safeParse({ ...repo, want: { ...repo.want, access: 'admin' } }).success).toBe(false)

    const oauth = { kind: 'connection', want: { type: 'mcp-oauth', server: 'Linear' } } as const
    expect(capabilityTarget(oauth)).toBe('mcp-oauth:Linear')
    expect(
      CapabilityAsk.safeParse({ kind: 'connection', want: { type: 'mcp-oauth', server: 'Linear', token: 'x' } }).success
    ).toBe(false)

    const header = {
      kind: 'secret',
      want: { name: 'X-Api-Key', description: 'Grafana API key', use: { route: 'mcp-header', server: 'Grafana' } }
    } as const
    expect(CapabilityAsk.safeParse(header).success).toBe(true)
    expect(capabilityTarget(header)).toBe('mcp-header:Grafana:X-Api-Key')
    // A live secret is named like an environment variable, and no want ever carries a value.
    const live = { kind: 'secret', want: { name: 'X-Api-Key', description: 'd', use: { route: 'live' } } }
    expect(CapabilityAsk.safeParse(live).success).toBe(false)
    expect(
      CapabilityAsk.safeParse({ ...live, want: { ...live.want, name: 'GRAFANA_TOKEN', value: 'secret' } }).success
    ).toBe(false)
  })
})
