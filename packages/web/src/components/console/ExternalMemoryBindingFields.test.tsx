// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
  connection: {
    id: '11111111-1111-4111-8111-111111111111',
    installationId: '22222222-2222-4222-8222-222222222222',
    status: 'ready',
    declaredEgressHosts: ['api.mem0.example']
  },
  installation: {
    id: '22222222-2222-4222-8222-222222222222',
    pluginId: 'ai.mem0.memory.oss',
    transport: 'streamable-http',
    endpoint: 'https://memory.example/mcp',
    commandRef: null
  }
}))

vi.mock('swr', () => ({
  default: (key: readonly unknown[] | null) => {
    const resource = key?.[2]
    if (resource === 'external-memory-connections') {
      return { data: [fixtures.connection], error: undefined, isLoading: false }
    }
    return { data: [fixtures.installation], error: undefined, isLoading: false }
  }
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, orgPath: (path: string) => path })
}))

import {
  connectionEndpointDisplay,
  connectionStatusNotice,
  DEFAULT_EXTERNAL_MEMORY_BINDING,
  ExternalMemoryBindingFields
} from './ExternalMemoryBindingFields'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DEFAULT_EXTERNAL_MEMORY_BINDING', () => {
  it('leaves end-to-end headroom around a healthy one-second remote recall', () => {
    expect(DEFAULT_EXTERNAL_MEMORY_BINDING.recall.timeoutMs).toBe(3000)
  })
})

describe('connectionEndpointDisplay', () => {
  it('shows the operator command for a local stdio plugin instead of an endpoint', () => {
    expect(connectionEndpointDisplay({ transport: 'stdio', endpoint: null, commandRef: 'mem0-oss' })).toEqual({
      label: 'Operator command',
      value: 'mem0-oss'
    })
  })

  it('shows the network endpoint for a remote plugin', () => {
    expect(
      connectionEndpointDisplay({
        transport: 'streamable-http',
        endpoint: 'https://relay.example/mem',
        commandRef: null
      })
    ).toEqual({ label: 'Plugin endpoint', value: 'https://relay.example/mem' })
  })

  it('falls back without inventing an endpoint when no installation is selected', () => {
    expect(connectionEndpointDisplay(undefined)).toEqual({ label: 'Plugin endpoint', value: 'unavailable' })
  })
})

describe('connectionStatusNotice', () => {
  it('shows no banner for a ready local connection', () => {
    expect(connectionStatusNotice('ready')).toBeNull()
  })

  it('frames probing as the initial compatibility check', () => {
    const notice = connectionStatusNotice('probing')
    expect(notice?.tone).toBe('progress')
    expect(notice?.text.toLowerCase()).toContain('verifying')
  })

  it('frames an admitted-degraded revision as temporarily unavailable, not needing initial verification', () => {
    const notice = connectionStatusNotice('degraded')
    expect(notice?.tone).toBe('warn')
    expect(notice?.text).toMatch(/temporarily unavailable/i)
    expect(notice?.text).toMatch(/fails open|keeps running/i)
    // The old copy wrongly told an already-admitted connection it still had to
    // pass a first compatibility check; that must not reappear here.
    expect(notice?.text).not.toMatch(/compatibility check/i)
  })

  it('frames invalid as a proven static failure that needs an update', () => {
    const notice = connectionStatusNotice('invalid')
    expect(notice?.tone).toBe('error')
    expect(notice?.text).toMatch(/conformance|failed/i)
  })
})

describe('ExternalMemoryBindingFields capture confirmation', () => {
  it('uses an app dialog before enabling automatic turn capture', async () => {
    const nativeConfirm = vi.fn(() => true)
    vi.stubGlobal('confirm', nativeConfirm)
    const onChange = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <ExternalMemoryBindingFields
          value={{
            ...DEFAULT_EXTERNAL_MEMORY_BINDING,
            connectionId: fixtures.connection.id,
            recall: { ...DEFAULT_EXTERNAL_MEMORY_BINDING.recall }
          }}
          onChange={onChange}
        />
      )
    })

    const everyTurnButtons = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.textContent === 'Every turn'
    )
    expect(everyTurnButtons).toHaveLength(2)
    await act(async () => everyTurnButtons[1]?.click())

    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.textContent).toContain('Enable automatic capture')
    expect(dialog?.textContent).toContain('api.mem0.example')

    const confirmButton = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Enable capture'
    )
    await act(async () => confirmButton?.click())

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ captureMode: 'turn' }))
  })
})
