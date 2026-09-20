// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTEGRATION_SETUP_URI } from '@agentconnect.md/protocol/mcp-app'
import { McpAppCard } from './McpAppCard'
import { mcpAppCard } from './session-work'
import type { SessionStep } from '@/lib/data'

const modal = vi.hoisted(() => ({ openNativeIntegration: vi.fn(() => true), closeNativeIntegration: vi.fn() }))
vi.mock('./ModalProvider', () => ({ useOptionalModal: () => modal }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let element: HTMLDivElement
let root: ReturnType<typeof createRoot>
const app = (): NonNullable<SessionStep['app']> => ({
  appId: crypto.randomUUID(),
  title: 'Integration configuration',
  toolName: 'agentconnect-admin__configureIntegration',
  nativeUi: {
    resourceUri: INTEGRATION_SETUP_URI,
    resourceVersion: 1,
    orgId: '11111111-1111-4111-8111-111111111111',
    intent: { mode: 'create', provider: 'github' }
  }
})
beforeEach(() => {
  modal.openNativeIntegration.mockClear()
  modal.closeNativeIntegration.mockClear()
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(() => {
  act(() => root.unmount())
  element.remove()
})

describe('native integration UI', () => {
  it('keeps a persisted card reopenable after a refresh without reopening the dialog automatically', async () => {
    const value = app()
    const onRpc = vi.fn(async () => ({ ok: true as const, result: {} }))
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onRpc={onRpc} />)
    })
    act(() => root.unmount())
    root = createRoot(element)
    const restored = mcpAppCard(JSON.stringify(value))!
    expect(restored.nativeUi).toEqual(value.nativeUi)
    await act(async () => {
      root.render(<McpAppCard step={{ app: restored }} onRpc={onRpc} />)
    })
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
    expect(element.querySelector('iframe')).toBeNull()
    expect(element.textContent).toContain('Open configuration')
    await act(async () => {
      element.querySelector('button')!.click()
    })
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(2)
  })

  it('waits for an explicit click when another dialog is open', async () => {
    modal.openNativeIntegration.mockReturnValueOnce(false)
    const value = app()
    const onRpc = vi.fn(async () => ({ ok: true as const, result: {} }))
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onRpc={onRpc} />)
    })
    expect(element.textContent).toContain('Close the current dialog')
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value } }} onRpc={onRpc} />)
    })
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
    await act(async () => {
      element.querySelector('button')!.click()
    })
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(2)
  })
  it('closes an expired dialog but leaves a completed one available for its final reveal step', async () => {
    const value = app()
    const onRpc = vi.fn(async () => ({ ok: true as const, result: {} }))
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onRpc={onRpc} />)
    })
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value, outcome: 'completed' } }} onRpc={onRpc} />)
    })
    expect(modal.closeNativeIntegration).not.toHaveBeenCalled()
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value, outcome: 'expired' } }} onRpc={onRpc} />)
    })
    expect(modal.closeNativeIntegration).toHaveBeenCalledWith(value.appId)
  })
  it('opens a native dialog once without an iframe or a second MCP call', async () => {
    const value = app()
    const onRpc = vi.fn(async () => ({ ok: true as const, result: {} }))
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onRpc={onRpc} />)
    })
    expect(element.querySelector('iframe')).toBeNull()
    expect(onRpc).not.toHaveBeenCalled()
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value } }} onRpc={onRpc} />)
    })
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
  })
  it('does not open a settled request or a history card by itself, but still offers the way back', async () => {
    const settled = { ...app(), outcome: 'expired' as const }
    await act(async () => {
      root.render(<McpAppCard step={{ app: settled }} onRpc={async () => ({ ok: true, result: {} })} />)
    })
    expect(modal.openNativeIntegration).not.toHaveBeenCalled()
    // Opening needs no bridge — a dialog the reader cannot reach again is the bug this guards.
    expect(element.textContent).toContain('Open again')
    await act(async () => element.querySelector('button')!.click())
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    root = createRoot(element)
    await act(async () => {
      root.render(<McpAppCard step={{ app: app() }} />)
    })
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
    await act(async () => element.querySelector('button')!.click())
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(2)
  })

  it('reopens a completed card and says plainly when the agent can no longer be told', async () => {
    const value = app()
    const onRpc = vi.fn(async () => ({ ok: true as const, result: {} }))
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onRpc={onRpc} />)
    })
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value, outcome: 'completed' } }} onRpc={onRpc} />)
    })
    expect(element.textContent).toContain('Open again')
    await act(async () => element.querySelector('button')!.click())
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(2)
    const completed = (modal.openNativeIntegration.mock.calls[1] as unknown as [unknown, (text: string) => void])[1]
    await act(async () => completed('Reviewed the code host connections.'))
    // The saves already applied under the reader's own Console session; only the note is missing.
    expect(onRpc).not.toHaveBeenCalled()
    expect(element.textContent).toContain('the agent was not notified')
  })
  it('never calls a refused submit a save, even when the agent cannot be told', async () => {
    const value = app()
    const onRpc = vi.fn(async () => ({ ok: true as const, result: {} }))
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onRpc={onRpc} />)
    })
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value, outcome: 'completed' } }} onRpc={onRpc} />)
    })
    await act(async () => element.querySelector('button')!.click())
    const completed = (
      modal.openNativeIntegration.mock.calls[1] as unknown as [
        unknown,
        (text: string, outcome?: 'saved' | 'failed') => void
      ]
    )[1]
    await act(async () => completed('Creating the agent failed: that name is taken', 'failed'))
    expect(element.textContent).toContain('Creating the agent failed')
    expect(element.textContent).not.toContain('changes are saved')
    expect(element.textContent).toContain('the agent was not told')
  })

  it('reports successful completion once and never reports opening as creation', async () => {
    const onRpc = vi.fn(async () => ({ ok: true as const, result: {} }))
    await act(async () => {
      root.render(<McpAppCard step={{ app: app() }} onRpc={onRpc} />)
    })
    expect(onRpc).not.toHaveBeenCalled()
    const completed = (modal.openNativeIntegration.mock.calls[0] as unknown as [unknown, (text: string) => void])[1]
    await act(async () => {
      completed('Created GitHub subscription.')
      completed('Created GitHub subscription.')
    })
    expect(onRpc).toHaveBeenCalledTimes(1)
    expect(element.textContent).toContain('Created GitHub subscription.')
  })
})
