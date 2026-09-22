import { describe, it, expect } from 'vitest'
import { cpRuntimeEnv } from '../src/agents/cp-overlay.js'
import type { LoadedAgent } from '../src/agents/load-agents.js'

const base = (over: Partial<LoadedAgent> = {}): LoadedAgent =>
  ({
    id: 'a1',
    name: 'local-name',
    status: 'active',
    runtime: 'claude',
    workspace: { mode: 'from-scratch', path: '/ws', gitBranch: 'main', pullOnNewSession: true, skills: [] },
    integrations: [],
    output: { mode: 'low' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: [],
    dir: '/agents/a1',
    ...over
  }) as LoadedAgent

describe('cpRuntimeEnv', () => {
  it('emits AGENTCONNECT_* only for set fields', () => {
    expect(cpRuntimeEnv(base())).toEqual({})
    expect(
      cpRuntimeEnv(
        base({
          runtimeOverrides: { model: 'opus', env: [], secrets: [] },
          reasoningEffort: 'high',
          executionMode: 'yolo'
        })
      )
    ).toEqual({
      AGENTCONNECT_MODEL: 'opus',
      AGENTCONNECT_REASONING_EFFORT: 'high',
      AGENTCONNECT_EXECUTION_MODE: 'yolo'
    })
  })

  it('also emits the runtime-native model variable for runtimes with no ACP model selector', () => {
    const gemini = base({ runtime: 'gemini', runtimeOverrides: { model: 'gemini-3.8-flash', env: [], secrets: [] } })
    expect(cpRuntimeEnv(gemini)).toEqual({ AGENTCONNECT_MODEL: 'gemini-3.8-flash', GEMINI_MODEL: 'gemini-3.8-flash' })
    // No model configured ⇒ neither variable, so the runtime keeps its own default.
    expect(cpRuntimeEnv(base({ runtime: 'gemini' }))).toEqual({})
    // ACP-selecting runtimes never get a native variable they do not read.
    expect(cpRuntimeEnv(base({ runtimeOverrides: { model: 'opus', env: [], secrets: [] } }))).not.toHaveProperty(
      'GEMINI_MODEL'
    )
  })

  it('does NOT emit a system-prompt env — the system prompt rides _meta.systemPrompt', () => {
    expect(cpRuntimeEnv(base({ description: 'you are a helpful agent' }))).toEqual({})
  })
})
