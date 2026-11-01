import { describe, expect, it } from 'vitest'
import { capabilitySummary, capabilityWarnings, evaluateCapability, skillSourceOf } from './capability-wording.js'

const agent = {
  model: 'small',
  reasoningEffort: null,
  fastMode: null,
  outputMode: 'low',
  permissionMode: 'default',
  mcpServers: ['GitHub'],
  skills: ['acme/*', 'tools/lint'],
  runtime: 'claude-acp',
  execution: 'srt',
  chatActions: 'talk' as const,
  introduceOnJoin: false,
  showFooter: true,
  showStatusBar: false,
  displayName: null
}

describe('capability wording', () => {
  it('words what was asked from want', () => {
    expect(capabilitySummary({ kind: 'mcp-server', want: { server: 'Linear' } })).toBe('add the MCP server "Linear"')
    expect(capabilitySummary({ kind: 'skill', want: { skill: 'acme/lint' } })).toBe('install the skill "acme/lint"')
    expect(capabilitySummary({ kind: 'agent-settings', want: { model: 'big', fastMode: true } })).toBe(
      'set the model to "big" and turn fast mode on'
    )
  })

  it('holds a settings request only when every wanted field matches', () => {
    expect(evaluateCapability({ kind: 'agent-settings', want: { model: 'small' } }, agent)).toEqual({
      satisfied: true,
      outcome: 'The model is "small".',
      current: { model: 'small' }
    })
    const differs = evaluateCapability({ kind: 'agent-settings', want: { model: 'big', outputMode: 'low' } }, agent)
    expect(differs.satisfied).toBe(false)
    expect(differs.outcome).toBe('The model is "small" (you asked for "big") and the output mode is "low".')
    expect(differs.current).toEqual({ model: 'small', outputMode: 'low' })
  })

  it('judges every agent-form field, and says a new runtime replays the conversation', () => {
    const ask = { kind: 'agent-settings', want: { runtime: 'codex-acp', model: 'gpt-5' } } as const
    expect(capabilitySummary(ask)).toBe('set the runtime to "codex-acp" and set the model to "gpt-5"')
    expect(evaluateCapability(ask, agent)).toMatchObject({
      satisfied: false,
      current: { runtime: 'claude-acp', model: 'small' }
    })
    const switched = evaluateCapability(ask, { ...agent, runtime: 'codex-acp', model: 'gpt-5' })
    expect(switched.satisfied).toBe(true)
    expect(switched.outcome).toContain('from a replay of its history')
    expect(capabilitySummary({ kind: 'agent-settings', want: { showStatusBar: true } })).toBe('turn the status bar on')
    expect(evaluateCapability({ kind: 'agent-settings', want: { displayName: 'Ops' } }, agent).outcome).toBe(
      'The display name is unset (you asked for "Ops").'
    )
    expect(capabilityWarnings(ask, agent)).toHaveLength(1)
    expect(capabilityWarnings({ kind: 'agent-settings', want: { execution: 'host' } }, agent)).toHaveLength(1)
    expect(capabilityWarnings({ kind: 'agent-settings', want: { chatActions: 'settings' } }, agent)).toHaveLength(1)
    expect(capabilityWarnings({ kind: 'agent-settings', want: { chatActions: 'talk' } }, agent)).toEqual([])
  })

  it('judges a cron by the agent’s own crons', () => {
    const want = { schedule: '0 9 * * 1', timezone: 'Asia/Tokyo', trigger: 'send the report' }
    const cron = {
      id: 'c1',
      name: null,
      schedule: '0 9 * * 1',
      timezone: 'Asia/Tokyo',
      trigger: 'send the report',
      enabled: true
    }
    expect(capabilitySummary({ kind: 'cron', want })).toBe('schedule a task on "0 9 * * 1" (Asia/Tokyo)')
    expect(evaluateCapability({ kind: 'cron', want }, agent, { crons: [] })).toMatchObject({
      satisfied: false,
      current: { cronId: null, exists: false }
    })
    expect(evaluateCapability({ kind: 'cron', want }, agent, { crons: [cron] })).toMatchObject({
      satisfied: true,
      current: { cronId: 'c1' }
    })
    expect(evaluateCapability({ kind: 'cron', want }, agent, { crons: [{ ...cron, enabled: false }] }).satisfied).toBe(
      false
    )
    const change = { kind: 'cron', want: { ...want, cronId: 'c2', schedule: '0 10 * * 1' } } as const
    const other = { ...cron, id: 'c2' }
    expect(evaluateCapability(change, agent, { crons: [cron, other] })).toMatchObject({
      satisfied: false,
      current: { cronId: 'c2' }
    })
    expect(evaluateCapability(change, agent, { crons: [{ ...other, schedule: '0 10 * * 1' }] }).satisfied).toBe(true)
    expect(capabilityWarnings({ kind: 'cron', want }, agent)).toHaveLength(1)
  })

  it('reads MCP servers by name and skills by name or a whole source', () => {
    expect(evaluateCapability({ kind: 'mcp-server', want: { server: 'GitHub' } }, agent).satisfied).toBe(true)
    expect(evaluateCapability({ kind: 'mcp-server', want: { server: 'Linear' } }, agent)).toMatchObject({
      satisfied: false,
      outcome: 'MCP server "Linear" was not added to this agent.'
    })
    expect(evaluateCapability({ kind: 'skill', want: { skill: 'acme/deploy' } }, agent).satisfied).toBe(true)
    expect(evaluateCapability({ kind: 'skill', want: { skill: 'tools/lint' } }, agent).satisfied).toBe(true)
    expect(evaluateCapability({ kind: 'skill', want: { skill: 'tools/fmt' } }, agent).satisfied).toBe(false)
    expect(skillSourceOf('org/repo/skill')).toBe('org/repo')
  })

  it('warns on a permission mode that never asks or decides on its own', () => {
    expect(
      capabilityWarnings({ kind: 'agent-settings', want: { permissionMode: 'bypassPermissions' } }, agent)
    ).toHaveLength(1)
    expect(capabilityWarnings({ kind: 'agent-settings', want: { permissionMode: 'auto' } }, agent)).toHaveLength(1)
    expect(capabilityWarnings({ kind: 'agent-settings', want: { permissionMode: 'default' } }, agent)).toEqual([])
    expect(capabilityWarnings({ kind: 'mcp-server', want: { server: 'Linear' } }, agent)).toEqual([])
  })

  it('words and judges the Phase 2 kinds from facts, never a secret value', () => {
    const repo = {
      kind: 'repository',
      want: { provider: 'github', repository: 'acme/widgets', access: 'write' }
    } as const
    expect(capabilitySummary(repo)).toBe('grant write access to the GitHub repository "acme/widgets"')
    expect(evaluateCapability(repo, agent).satisfied).toBe(false)
    const partial = evaluateCapability(repo, agent, {
      repository: { authorized: 'read', repoId: '7', installationId: null, installationWide: false }
    })
    expect(partial).toMatchObject({
      satisfied: false,
      outcome: 'The agent can read the GitHub repository "acme/widgets" (you asked for write access).',
      current: { authorized: 'read', repoId: '7', installationId: null }
    })
    expect(
      capabilityWarnings(repo, agent, {
        repository: { authorized: 'write', repoId: null, installationId: '9', installationWide: true }
      })
    ).toHaveLength(2)

    expect(
      capabilitySummary({
        kind: 'connection',
        want: { type: 'code-host', provider: 'gitlab', host: 'git.example.test' }
      })
    ).toBe('connect GitLab (git.example.test) to the organization')
    const chat = { kind: 'connection', want: { type: 'chat-integration', platform: 'slack' } } as const
    expect(evaluateCapability(chat, agent, { integrationConnected: true })).toMatchObject({
      satisfied: true,
      current: { connected: true }
    })

    const header = {
      kind: 'secret',
      want: { name: 'X-Api-Key', description: 'the Grafana key', use: { route: 'mcp-header', server: 'Grafana' } }
    } as const
    expect(capabilitySummary(header)).toBe('set the header "X-Api-Key" of the MCP server "Grafana"')
    const missing = evaluateCapability(header, agent, {
      mcpProvider: { providerId: 'p', connected: false, headerPresent: false }
    })
    expect(missing).toEqual({
      satisfied: false,
      outcome: 'Header "X-Api-Key" of MCP server "Grafana" is still not set.',
      current: { providerId: 'p', present: false }
    })
  })

  it('warns that the agent can read a live secret, and judges it by its name alone', () => {
    const live = {
      kind: 'secret',
      want: { name: 'GRAFANA_TOKEN', description: 'Grafana', use: { route: 'live' } }
    } as const
    expect(capabilityWarnings(live, { runtime: 'claude-acp' })).toEqual([
      'The agent can read this value: its own commands load it when they need it.'
    ])
    expect(evaluateCapability(live, {} as never, { liveSecretPresent: false })).toMatchObject({
      satisfied: false,
      current: { present: false }
    })
    expect(evaluateCapability(live, {} as never, { liveSecretPresent: true }).outcome).not.toMatch(/value/i)
  })
})
