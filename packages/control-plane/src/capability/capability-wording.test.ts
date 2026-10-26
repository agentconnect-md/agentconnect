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
  runtime: 'claude-acp'
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
})
