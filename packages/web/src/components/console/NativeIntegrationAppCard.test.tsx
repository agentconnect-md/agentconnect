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
  localStorage.clear()
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
    const onReport = vi.fn(() => true)
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={onReport} />)
    })
    act(() => root.unmount())
    // A RELOAD, not a remount: the module's in-memory card state goes with the page, and only
    // `sessionStorage` survives to say this card already had its one automatic opening.
    vi.resetModules()
    const { McpAppCard: Reloaded } = await import('./McpAppCard')
    root = createRoot(element)
    const restored = mcpAppCard(JSON.stringify(value))!
    expect(restored.nativeUi).toEqual(value.nativeUi)
    await act(async () => {
      root.render(<Reloaded step={{ app: restored }} onReport={onReport} />)
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
    const onReport = vi.fn(() => true)
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={onReport} />)
    })
    expect(element.textContent).toContain('Close the current dialog')
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value } }} onReport={onReport} />)
    })
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
    await act(async () => {
      element.querySelector('button')!.click()
    })
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(2)
  })
  it('closes an expired dialog but leaves a completed one available for its final reveal step', async () => {
    const value = app()
    const onReport = vi.fn(() => true)
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={onReport} />)
    })
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value, outcome: 'completed' } }} onReport={onReport} />)
    })
    expect(modal.closeNativeIntegration).not.toHaveBeenCalled()
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value, outcome: 'expired' } }} onReport={onReport} />)
    })
    expect(modal.closeNativeIntegration).toHaveBeenCalledWith(value.appId)
  })
  it('opens a native dialog once without an iframe or a second MCP call', async () => {
    const value = app()
    const onReport = vi.fn(() => true)
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={onReport} />)
    })
    expect(element.querySelector('iframe')).toBeNull()
    expect(onReport).not.toHaveBeenCalled()
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value } }} onReport={onReport} />)
    })
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
  })
  it('does not open a settled request or a history card by itself, but still offers the way back', async () => {
    const settled = { ...app(), outcome: 'expired' as const }
    await act(async () => {
      root.render(<McpAppCard step={{ app: settled }} onReport={() => true} />)
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
    const onReport = vi.fn(() => true)
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={onReport} />)
    })
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value, outcome: 'completed' } }} onReport={onReport} />)
    })
    expect(element.textContent).toContain('Open again')
    await act(async () => element.querySelector('button')!.click())
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(2)
    const completed = (modal.openNativeIntegration.mock.calls[1] as unknown as [unknown, (text: string) => void])[1]
    await act(async () => completed('Reviewed the code host connections.'))
    // The saves already applied under the reader's own Console session; only the note is missing.
    expect(onReport).not.toHaveBeenCalled()
    expect(element.textContent).toContain('the agent was not notified')
  })
  it('never calls a refused submit a save, even when the agent cannot be told', async () => {
    const value = app()
    const onReport = vi.fn(() => true)
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={onReport} />)
    })
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value, outcome: 'completed' } }} onReport={onReport} />)
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

  // The transcript re-keys a turn when its live steps become persisted rows, so the card under an
  // open dialog is remounted rather than re-rendered. The dialog goes back, and — the bug this
  // guards — the form the reader then submits still reaches the conversation.
  it('puts the dialog back when the card is remounted under it, and still reports', async () => {
    const value = app()
    const onReport = vi.fn(() => true)
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={onReport} />)
    })
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    root = createRoot(element)
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value } }} onReport={onReport} />)
    })
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(2)
    const completed = (modal.openNativeIntegration.mock.calls[1] as unknown as [unknown, (text: string) => void])[1]
    await act(async () => completed('Created agent example-qa (agentId 11111111-1111-4111-8111-111111111111).'))
    expect(onReport).toHaveBeenCalledWith('Created agent example-qa (agentId 11111111-1111-4111-8111-111111111111).')
    expect(element.textContent).not.toContain('could not be notified')
  })

  // Accepting a turn is not delivering one — it can still be queued where the reader may cancel it
  // — so a delivered report settles nothing. It only stops ANOTHER TAB, which has its own
  // `sessionStorage`, from opening a dialog over a form that was already submitted.
  it('records a delivered report for other tabs without settling the card', async () => {
    const value = app()
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={() => true} />)
    })
    const landed = (modal.openNativeIntegration.mock.calls[0] as unknown as [unknown, (text: string) => void])[1]
    await act(async () => landed('Created GitHub subscription.'))
    vi.resetModules()
    const { McpAppCard: OtherTab } = await import('./McpAppCard')
    modal.openNativeIntegration.mockClear()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => {
      root.render(<OtherTab step={{ app: { ...value } }} onReport={() => true} />)
    })
    expect(modal.openNativeIntegration).not.toHaveBeenCalled()
    expect(element.textContent).toContain('Created GitHub subscription.')
  })

  it('records nothing when the conversation would not take the report', async () => {
    const value = app()
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={() => false} />)
    })
    const dropped = (modal.openNativeIntegration.mock.calls[0] as unknown as [unknown, (text: string) => void])[1]
    await act(async () => dropped('Created GitHub subscription.'))
    expect(localStorage.getItem(`ac.native-ui.reported.${value.appId}`)).toBeNull()
  })

  // A settlement arriving after the dialog reported must not shut the reveal step that dialog kept.
  it('does not close a reported dialog when its card then settles', async () => {
    const value = app()
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={() => true} />)
    })
    const completed = (modal.openNativeIntegration.mock.calls[0] as unknown as [unknown, (text: string) => void])[1]
    await act(async () => completed('Created webhook integration.'))
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value, outcome: 'closed' } }} onReport={() => true} />)
    })
    expect(modal.closeNativeIntegration).not.toHaveBeenCalled()
  })

  // Navigating away unmounts the card with its dialog still open, exactly as a remount does — but
  // coming back later is not the same commit, and the reader who left is not asking for the form
  // to be thrown at them again.
  it('does not reopen a dialog the reader navigated away from', async () => {
    vi.useFakeTimers()
    try {
      const value = app()
      const onReport = vi.fn(() => true)
      await act(async () => {
        root.render(<McpAppCard step={{ app: value }} onReport={onReport} />)
      })
      expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
      act(() => root.unmount())
      vi.advanceTimersByTime(60_000)
      root = createRoot(element)
      await act(async () => {
        root.render(<McpAppCard step={{ app: { ...value } }} onReport={onReport} />)
      })
      expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
      expect(element.textContent).toContain('Open configuration')
    } finally {
      vi.useRealTimers()
    }
  })

  // A reader who already submitted says nothing either: the dialog reported and closed itself.
  it('does not reopen a dialog that already reported', async () => {
    const value = app()
    const onReport = vi.fn(() => true)
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={onReport} />)
    })
    const completed = (modal.openNativeIntegration.mock.calls[0] as unknown as [unknown, (text: string) => void])[1]
    await act(async () => completed('Created GitHub subscription.'))
    act(() => root.unmount())
    root = createRoot(element)
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value } }} onReport={onReport} />)
    })
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
  })

  it('tells the reader when the conversation would not take the report', async () => {
    const onReport = vi.fn(() => false)
    await act(async () => {
      root.render(<McpAppCard step={{ app: app() }} onReport={onReport} />)
    })
    const completed = (modal.openNativeIntegration.mock.calls[0] as unknown as [unknown, (text: string) => void])[1]
    await act(async () => completed('Created GitHub subscription.'))
    expect(element.textContent).toContain('Configuration was saved, but the agent could not be notified.')
  })

  it('reports successful completion once and never reports opening as creation', async () => {
    const onReport = vi.fn(() => true)
    await act(async () => {
      root.render(<McpAppCard step={{ app: app() }} onReport={onReport} />)
    })
    expect(onReport).not.toHaveBeenCalled()
    const completed = (modal.openNativeIntegration.mock.calls[0] as unknown as [unknown, (text: string) => void])[1]
    await act(async () => {
      completed('Created GitHub subscription.')
      completed('Created GitHub subscription.')
    })
    expect(onReport).toHaveBeenCalledTimes(1)
    expect(element.textContent).toContain('Created GitHub subscription.')
  })
})
