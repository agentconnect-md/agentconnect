import { describe, expect, it } from 'vitest'
import { AgentSpec } from './agent.js'
import { AssistantModePolicy } from './assistant-mode.js'
import { assistantModeDefinitionRefusals, assistantModeRuntimeAdmitted } from '../assistant-mode-admission.js'
import {
  ASSISTANT_MODE_PERMISSION_MODES,
  assistantModePermissionModeOnEnable,
  autoOrFullAccessPermissionMode
} from '../assistant-permission-modes.js'

const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222'

describe('AssistantModePolicy', () => {
  it('needs no routing target: the responsible user is derived and there is no fallback conversation', () => {
    expect(AssistantModePolicy.parse({ enabled: true })).toEqual({ enabled: true })
    expect(AssistantModePolicy.parse({ enabled: false })).toEqual({ enabled: false })
    expect(AssistantModePolicy.safeParse({ enabled: true, responsibleUserId: 'usr_1' }).success).toBe(false)
    expect(
      AssistantModePolicy.safeParse({
        enabled: true,
        fallbackConversation: { integrationId: INTEGRATION_ID, channelId: 'C123' }
      }).success
    ).toBe(false)
  })

  it('is strict and bounds its limits', () => {
    expect(AssistantModePolicy.safeParse({ enabled: false, extra: 1 }).success).toBe(false)
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
    expect(AgentSpec.parse({ ...base, assistantMode: { enabled: true } }).assistantMode).toEqual({ enabled: true })
  })
})

describe('assistant mode admission', () => {
  it('admits only runtimes whose facts are all established', () => {
    for (const runtime of ['claude-acp', 'claude', 'codex-acp', 'codex', 'opencode']) {
      expect(assistantModeRuntimeAdmitted(runtime), runtime).toBe(true)
    }
    expect(assistantModeRuntimeAdmitted('qwen-code')).toBe(false)
    expect(assistantModeRuntimeAdmitted('some-new-runtime')).toBe(false)
    expect(assistantModeRuntimeAdmitted('constructor')).toBe(false)
  })

  it('refuses an unset or unlisted runtime and memory other than managed or none', () => {
    expect(assistantModeDefinitionRefusals({ runtime: 'claude-acp', memory: null })).toEqual([])
    expect(assistantModeDefinitionRefusals({ runtime: 'claude-acp', memory: { provider: 'none' } })).toEqual([])
    expect(assistantModeDefinitionRefusals({ runtime: 'codex-acp', memory: { provider: 'none' } })).toEqual([])
    expect(assistantModeDefinitionRefusals({ runtime: 'opencode', memory: null })).toEqual([])
    expect(assistantModeDefinitionRefusals({ runtime: null, memory: undefined })).toEqual(['runtime-unset'])
    expect(assistantModeDefinitionRefusals({ runtime: 'codex-acp', memory: { provider: 'native' } })).toEqual([
      'memory-provider'
    ])
    expect(assistantModeDefinitionRefusals({ runtime: 'qwen-code', memory: { provider: 'native' } })).toEqual([
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

// assistant-mode.md §1.8: turning the mode on defaults the permission mode, and only moves one that would stop background work.
describe('assistant mode permission default', () => {
  it("moves an asking or read-only mode to the runtime's auto mode", () => {
    for (const mode of ['default', 'acceptEdits', 'plan', '', null, undefined]) {
      expect(assistantModePermissionModeOnEnable('claude-acp', mode)).toBe('auto')
    }
    expect(assistantModePermissionModeOnEnable('claude', 'default')).toBe('auto')
    for (const mode of ['read-only', 'workspace-write', null]) {
      expect(assistantModePermissionModeOnEnable('codex-acp', mode)).toBe('agent')
    }
  })

  it('keeps a mode that already runs unattended, and one it does not know', () => {
    for (const mode of ['auto', 'bypassPermissions', 'dontAsk', 'some-later-mode']) {
      expect(assistantModePermissionModeOnEnable('claude-acp', mode)).toBeUndefined()
    }
    for (const mode of ['agent', 'agent-full-access']) {
      expect(assistantModePermissionModeOnEnable('codex-acp', mode)).toBeUndefined()
    }
  })

  it('falls back to full access without an auto mode, and changes nothing with neither', () => {
    const table = {
      'example-full': { ask: 'asks', open: 'full-access' } as const,
      'example-asks': { ask: 'asks' } as const
    }
    expect(assistantModePermissionModeOnEnable('example-full', 'ask', table)).toBe('open')
    expect(assistantModePermissionModeOnEnable('example-full', undefined, table)).toBe('open')
    expect(assistantModePermissionModeOnEnable('example-asks', 'ask', table)).toBeUndefined()
    expect(assistantModePermissionModeOnEnable('opencode', 'build')).toBeUndefined()
    expect(assistantModePermissionModeOnEnable('some-new-runtime', 'default')).toBeUndefined()
    expect(assistantModePermissionModeOnEnable(null, 'default')).toBeUndefined()
    expect(assistantModePermissionModeOnEnable('claude-acp', 'constructor')).toBeUndefined()
  })
})

describe('a runtime’s auto, else full-access, permission mode', () => {
  it('picks the auto mode of every mode the runtime knows', () => {
    expect(autoOrFullAccessPermissionMode('claude-acp')).toBe('auto')
    expect(autoOrFullAccessPermissionMode('claude')).toBe('auto')
    expect(autoOrFullAccessPermissionMode('codex-acp')).toBe('agent')
    expect(autoOrFullAccessPermissionMode('codex')).toBe('agent')
  })

  const COPILOT_MODE = 'https://agentclientprotocol.com/protocol/session-modes#'

  it.each([
    ['antigravity-acp', { default: 'asks', auto_edit: 'asks', yolo: 'full-access' }, 'yolo'],
    [
      'codebuddy-code',
      {
        default: 'asks',
        acceptEdits: 'asks',
        plan: 'read-only',
        auto: 'auto',
        bypassPermissions: 'full-access',
        fullAccess: 'full-access'
      },
      'auto'
    ],
    ['devin', { ask: 'read-only', smart: 'auto', bypass: 'full-access' }, 'smart'],
    [
      'dsh-acp',
      { 'read-only': 'read-only', 'workspace-write': 'asks', 'danger-full-access': 'full-access' },
      'danger-full-access'
    ],
    ['github-copilot-cli', { [`${COPILOT_MODE}autopilot`]: 'full-access' }, `${COPILOT_MODE}autopilot`],
    ['qoder', { default: 'asks', acceptEdits: 'asks', auto: 'auto', yolo: 'full-access' }, 'auto'],
    ['qoder-cli', { default: 'asks', acceptEdits: 'asks', auto: 'auto', yolo: 'full-access' }, 'auto'],
    ['qoder-cli-cn', { default: 'asks', acceptEdits: 'asks', auto: 'auto', yolo: 'full-access' }, 'auto'],
    [
      'qwen-code',
      { plan: 'read-only', default: 'asks', 'auto-edit': 'asks', auto: 'auto', yolo: 'full-access' },
      'auto'
    ]
  ])('classifies %s’s reported modes and picks its auto, else full-access, one', (runtime, modes, picked) => {
    expect(ASSISTANT_MODE_PERMISSION_MODES[runtime]).toEqual(modes)
    expect(autoOrFullAccessPermissionMode(runtime)).toBe(picked)
  })

  it('leaves out every runtime with no reported mode that approves on its own', () => {
    for (const runtime of ['opencode', 'cline', 'cursor', 'kilo', 'omp', 'hermes-agent', 'kiro-cli', 'gemini']) {
      expect(ASSISTANT_MODE_PERMISSION_MODES[runtime]).toBeUndefined()
    }
  })

  it('picks among the modes the runtime’s catalog offers, full access when it offers no auto mode', () => {
    expect(autoOrFullAccessPermissionMode('claude-acp', ['default', 'auto', 'bypassPermissions'])).toBe('auto')
    expect(autoOrFullAccessPermissionMode('claude-acp', ['default', 'plan', 'bypassPermissions'])).toBe(
      'bypassPermissions'
    )
    expect(autoOrFullAccessPermissionMode('codex-acp', ['read-only', 'agent-full-access'])).toBe('agent-full-access')
    expect(autoOrFullAccessPermissionMode('qwen-code', ['plan', 'default', 'auto-edit', 'yolo'])).toBe('yolo')
    expect(autoOrFullAccessPermissionMode('codebuddy-code', ['default', 'fullAccess', 'bypassPermissions'])).toBe(
      'bypassPermissions'
    )
    expect(autoOrFullAccessPermissionMode('devin', ['accept-edits', 'ask', 'bypass'])).toBe('bypass')
  })

  it('has none for a catalog with neither, a runtime it does not know, or no runtime', () => {
    expect(autoOrFullAccessPermissionMode('claude-acp', ['default', 'acceptEdits', 'plan'])).toBeUndefined()
    expect(autoOrFullAccessPermissionMode('claude-acp', [])).toBeUndefined()
    expect(autoOrFullAccessPermissionMode('qoder-cli', ['default', 'acceptEdits', 'dontAsk'])).toBeUndefined()
    expect(autoOrFullAccessPermissionMode('devin', ['accept-edits', 'ask', 'plan'])).toBeUndefined()
    expect(
      autoOrFullAccessPermissionMode('github-copilot-cli', [`${COPILOT_MODE}agent`, `${COPILOT_MODE}plan`])
    ).toBeUndefined()
    expect(autoOrFullAccessPermissionMode('opencode')).toBeUndefined()
    expect(autoOrFullAccessPermissionMode(null)).toBeUndefined()
    expect(autoOrFullAccessPermissionMode('constructor')).toBeUndefined()
    const table = { 'example-full': { ask: 'asks', open: 'full-access' } as const }
    expect(autoOrFullAccessPermissionMode('example-full', undefined, table)).toBe('open')
    expect(autoOrFullAccessPermissionMode('example-full', ['ask'], table)).toBeUndefined()
  })
})
