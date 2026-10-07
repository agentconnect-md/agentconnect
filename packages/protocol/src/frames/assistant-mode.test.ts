import { describe, expect, it } from 'vitest'
import { AgentSpec } from './agent.js'
import { AssistantModePolicy } from './assistant-mode.js'
import { assistantModeDefinitionRefusals, assistantModeRuntimeAdmitted } from '../assistant-mode-admission.js'

const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222'

describe('AssistantModePolicy', () => {
  it('accepts an enabled policy with a responsible user or a fallback conversation', () => {
    expect(AssistantModePolicy.parse({ enabled: true, responsibleUserId: 'usr_1' })).toEqual({
      enabled: true,
      responsibleUserId: 'usr_1'
    })
    const fallbackConversation = { integrationId: INTEGRATION_ID, channelId: 'C123' }
    expect(AssistantModePolicy.parse({ enabled: true, fallbackConversation })).toEqual({
      enabled: true,
      fallbackConversation
    })
  })

  it('refuses an enabled policy with neither, but keeps a disabled one', () => {
    expect(AssistantModePolicy.safeParse({ enabled: true }).success).toBe(false)
    expect(AssistantModePolicy.parse({ enabled: false })).toEqual({ enabled: false })
  })

  it('is strict and bounds its limits', () => {
    expect(AssistantModePolicy.safeParse({ enabled: false, extra: 1 }).success).toBe(false)
    expect(
      AssistantModePolicy.safeParse({ enabled: false, fallbackConversation: { integrationId: 'nope', channelId: 'C' } })
        .success
    ).toBe(false)
    expect(AssistantModePolicy.safeParse({ enabled: false, limits: { permissionWaitHours: 73 } }).success).toBe(false)
    expect(
      AssistantModePolicy.parse({
        enabled: false,
        limits: {
          maxConcurrentSubsessions: 50,
          dailyPatrolBudget: 500,
          dailySubsessionsPerItem: 1,
          permissionWaitHours: 72
        }
      }).limits
    ).toEqual({
      maxConcurrentSubsessions: 50,
      dailyPatrolBudget: 500,
      dailySubsessionsPerItem: 1,
      permissionWaitHours: 72
    })
  })

  it('rides the agent spec as value, null, or absent', () => {
    const base = { name: 'a' }
    expect(AgentSpec.parse({ ...base, assistantMode: null }).assistantMode).toBeNull()
    expect(AgentSpec.parse(base).assistantMode).toBeUndefined()
    expect(
      AgentSpec.parse({ ...base, assistantMode: { enabled: true, responsibleUserId: 'u' } }).assistantMode
    ).toEqual({
      enabled: true,
      responsibleUserId: 'u'
    })
    expect(AgentSpec.safeParse({ ...base, assistantMode: { enabled: true } }).success).toBe(false)
  })
})

describe('assistant mode admission', () => {
  it('admits only runtimes whose facts are all established', () => {
    expect(assistantModeRuntimeAdmitted('claude-acp')).toBe(true)
    expect(assistantModeRuntimeAdmitted('claude')).toBe(true)
    expect(assistantModeRuntimeAdmitted('codex-acp')).toBe(false)
    expect(assistantModeRuntimeAdmitted('opencode')).toBe(false)
    expect(assistantModeRuntimeAdmitted('some-new-runtime')).toBe(false)
    expect(assistantModeRuntimeAdmitted('constructor')).toBe(false)
  })

  it('refuses an unset or unlisted runtime and memory other than managed or none', () => {
    expect(assistantModeDefinitionRefusals({ runtime: 'claude-acp', memory: null })).toEqual([])
    expect(assistantModeDefinitionRefusals({ runtime: 'claude-acp', memory: { provider: 'none' } })).toEqual([])
    expect(assistantModeDefinitionRefusals({ runtime: null, memory: undefined })).toEqual(['runtime-unset'])
    expect(assistantModeDefinitionRefusals({ runtime: 'codex-acp', memory: { provider: 'native' } })).toEqual([
      'runtime-not-admitted',
      'memory-provider'
    ])
    expect(
      assistantModeDefinitionRefusals({
        runtime: 'claude-acp',
        memory: {
          provider: 'external',
          connectionId: INTEGRATION_ID,
          recall: { mode: 'auto', topK: 5, maxBytes: 8192, timeoutMs: 3000 },
          capture: { mode: 'manual' }
        }
      })
    ).toEqual(['memory-provider'])
  })
})
