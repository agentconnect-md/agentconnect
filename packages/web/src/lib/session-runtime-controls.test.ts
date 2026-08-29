import { describe, expect, it } from 'vitest'
import {
  sessionAfterModelSelection,
  sessionEffortAfterModelChange,
  sessionEffortChoices,
  sessionEffortChoicesForSelection,
  sessionPermissionChoices,
  sessionPermissionSelection,
  sessionRuntimeChangesEnabled
} from '@/lib/session-runtime-controls'
import type { DaemonRow, RuntimeModelCatalog } from '@/lib/data'

const catalog: RuntimeModelCatalog = {
  models: [
    {
      id: 'sol',
      efforts: [
        { value: 'high', name: 'High' },
        { value: 'max', name: 'Max' }
      ],
      defaultEffort: 'max'
    },
    {
      id: 'terra',
      efforts: [{ value: 'high', name: 'High' }],
      defaultEffort: 'high'
    }
  ],
  defaultModel: 'sol',
  permissionModes: [
    { value: 'default', name: 'Ask' },
    { value: 'full-access', name: 'Full Access' }
  ],
  defaultPermissionMode: 'default',
  source: 'acp',
  observedAt: '2026-07-25T00:00:00.000Z'
}

const daemon = {
  runtimeModels: [{ runtime: 'codex', version: '1.0.0', models: ['sol', 'terra'], modelCatalog: catalog }]
} satisfies Pick<DaemonRow, 'runtimeModels'>

describe('session runtime controls', () => {
  it('allows a fresh Playground to stage runtime changes before its first turn', () => {
    expect(sessionRuntimeChangesEnabled(true, { platform: 'playground' })).toBe(true)
    expect(sessionRuntimeChangesEnabled(true, { platform: 'playground', realSessionId: 'session-1' })).toBe(true)
    expect(sessionRuntimeChangesEnabled(true, { platform: 'webchat' })).toBe(true)
    expect(sessionRuntimeChangesEnabled(true, { platform: 'slack' })).toBe(false)
    expect(sessionRuntimeChangesEnabled(false, { platform: 'webchat' })).toBe(false)
  })

  it('preserves a live permission list, including an explicit empty list', () => {
    expect(sessionPermissionChoices('codex', catalog, [])).toEqual([])
    expect(sessionPermissionChoices('codex', catalog, ['full-access'])).toEqual([
      { v: 'full-access', l: 'Full Access' }
    ])
    expect(sessionPermissionChoices('codex', catalog, undefined)).toHaveLength(2)
  })

  it('resolves the selected permission from a narrowed live list', () => {
    expect(sessionPermissionSelection('codex', catalog, ['default'], 'full-access')).toBe('default')
    expect(sessionPermissionSelection('codex', catalog, [], 'full-access')).toBe('full-access')
    expect(sessionPermissionSelection('codex', catalog, [], '')).toBe('default')
  })

  it('shows the runtime permission default when no override is stored', () => {
    expect(sessionPermissionSelection('codex', catalog, undefined, '')).toBe('default')
    expect(sessionPermissionSelection('codex', undefined, undefined, '')).toBe('agent')
  })

  it('offers exactly the Codex modes the catalog and the live session report', () => {
    const codexCatalog: RuntimeModelCatalog = {
      ...catalog,
      permissionModes: [
        { value: 'read-only', name: 'Ask for approval' },
        { value: 'agent', name: 'Approve for me' },
        { value: 'agent-full-access', name: 'Full access' }
      ],
      defaultPermissionMode: 'agent'
    }
    expect(sessionPermissionChoices('codex', codexCatalog, undefined).map((choice) => choice.v)).toEqual([
      'read-only',
      'agent',
      'agent-full-access'
    ])
    expect(sessionPermissionSelection('codex', codexCatalog, undefined, 'agent')).toBe('agent')
    expect(sessionPermissionChoices('codex', codexCatalog, ['read-only', 'agent', 'agent-full-access'])).toEqual([
      { v: 'read-only', l: 'Ask for approval' },
      { v: 'agent', l: 'Approve for me' },
      { v: 'agent-full-access', l: 'Full access' }
    ])
    expect(sessionPermissionSelection('codex', codexCatalog, ['read-only', 'agent-full-access'], 'agent')).toBe(
      'read-only'
    )
  })

  it('moves an unavailable effort to the selected model default', () => {
    expect(sessionEffortAfterModelChange('codex', daemon, 'terra', 'max')).toBe('high')
  })

  it('drops the previous model live efforts while a model change is pending', () => {
    const next = sessionAfterModelSelection({ model: 'sol', availableEfforts: ['high', 'max'] }, 'terra')

    expect(next).toEqual({ model: 'terra', availableEfforts: undefined })
    expect(sessionEffortChoices('codex', daemon, next.model, next.availableEfforts)).toEqual([
      { value: 'high', label: 'High' }
    ])
    expect(sessionEffortChoicesForSelection('codex', daemon, 'terra', 'sol', ['high', 'max'])).toEqual([
      { value: 'high', label: 'High' }
    ])
  })
})
