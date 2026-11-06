import { describe, expect, it } from 'vitest'
import type { RuntimeModelCatalog } from '@agentconnect.md/protocol'
import { coordinatorPermissionMode, coordinatorTarget } from '../src/auto-session/coordinator-model.js'

const catalog = (models: RuntimeModelCatalog['models']): RuntimeModelCatalog => ({
  models,
  source: 'acp',
  observedAt: '2026-11-06T00:00:00.000Z'
})

describe('coordinatorTarget', () => {
  it('keeps a chosen coordinator model as it is', () => {
    const target = coordinatorTarget(
      { runtime: 'claude-acp', coordinatorModel: { runtime: 'codex-acp', model: 'gpt-5.6-terra', fastMode: true } },
      () => undefined
    )
    expect(target).toEqual({ runtime: 'codex-acp', model: 'gpt-5.6-terra', effort: '', fastMode: true })
  })

  it("defaults to the runtime's small model at low effort", () => {
    const target = coordinatorTarget({ runtime: 'claude-acp', runtimeOverrides: { model: 'opus' } }, () =>
      catalog([{ id: 'opus' }, { id: 'haiku', efforts: [{ value: 'low' }, { value: 'high' }] }])
    )
    expect(target).toEqual({ runtime: 'claude-acp', model: 'haiku', effort: 'low', fastMode: false })
  })

  it('follows the task model where the runtime has no small model, leaving an effort the model lacks', () => {
    const target = coordinatorTarget({ runtime: 'opencode', runtimeOverrides: { model: 'a/b' } }, () =>
      catalog([{ id: 'a/b', efforts: [{ value: 'high' }] }])
    )
    expect(target).toEqual({ runtime: 'opencode', model: 'a/b', effort: '', fastMode: false })
  })
})

describe('coordinatorPermissionMode', () => {
  it('asks every write where the read-only mode changes the model, else runs read-only, else auto, never full access', () => {
    // Claude Code's plan mode runs Haiku as Sonnet, so its coordinator asks in `default` and every ask is refused.
    expect(coordinatorPermissionMode('claude-acp', ['default', 'plan', 'auto'])).toBe('default')
    expect(coordinatorPermissionMode('claude-acp', ['plan', 'auto'])).toBe('plan')
    expect(coordinatorPermissionMode('codex-acp', ['read-only', 'workspace-write', 'agent'])).toBe('read-only')
    expect(coordinatorPermissionMode('codebuddy-code', ['default', 'auto', 'bypassPermissions'])).toBe('auto')
    expect(coordinatorPermissionMode('antigravity-acp', ['default', 'yolo'])).toBeUndefined()
  })
})
