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
const completionOf = (call: number) =>
  (modal.openNativeIntegration.mock.calls[call] as unknown as [unknown, (t: string, o?: 'saved' | 'failed') => void])[1]
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
  // The Console holds ONE dialog, so a card that opened itself could only be refused and then
  // forgotten — which is how a turn that raised two of them stalled after the first.
  it('never opens itself, and says it is waiting instead', async () => {
    const onReport = vi.fn(() => true)
    await act(async () => {
      root.render(<McpAppCard step={{ app: app() }} onReport={onReport} />)
    })
    expect(modal.openNativeIntegration).not.toHaveBeenCalled()
    expect(element.querySelector('[data-native-app-status]')?.getAttribute('data-native-app-status')).toBe('waiting')
    expect(element.textContent).toContain('Waiting')
    expect(element.textContent).toContain('Open configuration')
    await act(async () => element.querySelector('button')!.click())
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
  })

  it('two cards in one turn both stay openable', async () => {
    const secondEl = document.body.appendChild(document.createElement('div'))
    const second = createRoot(secondEl)
    await act(async () => {
      root.render(<McpAppCard step={{ app: app() }} onReport={() => true} />)
      second.render(<McpAppCard step={{ app: app() }} onReport={() => true} />)
    })
    expect(modal.openNativeIntegration).not.toHaveBeenCalled()
    await act(async () => element.querySelector('button')!.click())
    // With the first dialog up the Console refuses the second — and that card SAYS so and stays
    // waiting, rather than going quiet with its one automatic opening already spent.
    modal.openNativeIntegration.mockReturnValueOnce(false)
    await act(async () => secondEl.querySelector('button')!.click())
    expect(secondEl.textContent).toContain('Close the current dialog')
    expect(secondEl.querySelector('[data-native-app-status]')?.getAttribute('data-native-app-status')).toBe('waiting')
    // The reader closes the first, comes back, and the second opens on the next click.
    await act(async () => secondEl.querySelector('button')!.click())
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(3)
    await act(async () => second.unmount())
    secondEl.remove()
  })

  it('reports a completion once and marks itself done', async () => {
    const onReport = vi.fn(() => true)
    await act(async () => {
      root.render(<McpAppCard step={{ app: app() }} onReport={onReport} />)
    })
    await act(async () => element.querySelector('button')!.click())
    const completed = completionOf(0)
    await act(async () => {
      completed('Created GitHub subscription.')
      completed('Created GitHub subscription.')
    })
    expect(onReport).toHaveBeenCalledTimes(1)
    expect(element.textContent).toContain('Created GitHub subscription.')
    expect(element.textContent).toContain('Done')
    expect(element.querySelector('[data-native-app-status]')?.getAttribute('data-native-app-status')).toBe('done')
    expect(element.textContent).toContain('Open again')
  })

  // The transcript re-keys a turn when its live steps become persisted rows, so the card under an
  // open dialog is remounted rather than re-rendered. The dialog goes back, and the form the reader
  // then submits still reaches the conversation.
  it('puts the dialog back when the card is remounted under it, and still reports', async () => {
    const value = app()
    const onReport = vi.fn(() => true)
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={onReport} />)
    })
    await act(async () => element.querySelector('button')!.click())
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    root = createRoot(element)
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value } }} onReport={onReport} />)
    })
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(2)
    await act(async () => completionOf(1)('Created agent example-qa (agentId 11111111-1111-4111-8111-111111111111).'))
    expect(onReport).toHaveBeenCalledWith('Created agent example-qa (agentId 11111111-1111-4111-8111-111111111111).')
    expect(element.textContent).not.toContain('could not be notified')
  })

  // Navigating away unmounts the card with its dialog open, exactly as a remount does — but coming
  // back later is not the same commit, and the reader who left is not asking for it again.
  it('does not reopen a dialog the reader navigated away from', async () => {
    vi.useFakeTimers()
    try {
      const value = app()
      await act(async () => {
        root.render(<McpAppCard step={{ app: value }} onReport={() => true} />)
      })
      await act(async () => element.querySelector('button')!.click())
      act(() => root.unmount())
      vi.advanceTimersByTime(60_000)
      root = createRoot(element)
      await act(async () => {
        root.render(<McpAppCard step={{ app: { ...value } }} onReport={() => true} />)
      })
      expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
      expect(element.textContent).toContain('Open configuration')
    } finally {
      vi.useRealTimers()
    }
  })

  // Accepting a turn is not delivering one — it can still be queued where the reader may cancel it
  // — so a delivered report settles nothing. It only tells ANOTHER TAB, which has its own component
  // state, that this form was already submitted.
  it('records a delivered report for other tabs without settling the card', async () => {
    const value = app()
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={() => true} />)
    })
    await act(async () => element.querySelector('button')!.click())
    await act(async () => completionOf(0)('Created GitHub subscription.'))
    const other = document.body.appendChild(document.createElement('div'))
    const tab = createRoot(other)
    await act(async () => {
      tab.render(<McpAppCard step={{ app: { ...value } }} onReport={() => true} />)
    })
    expect(other.textContent).toContain('Done')
    expect(other.textContent).toContain('Created GitHub subscription.')
    await act(async () => tab.unmount())
    other.remove()
  })

  // A sibling tab that was ALREADY open when this one submitted has its own component state, so it
  // has to hear about the write — otherwise it keeps its Waiting badge and invites the reader to
  // submit the same create twice, and nothing settles the card server-side to correct it later.
  it('adopts a report a sibling tab delivered while it was open', async () => {
    const value = app()
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={() => true} />)
    })
    expect(element.textContent).toContain('Waiting')
    const key = `ac.native-ui.reported.${value.appId}`
    localStorage.setItem(key, 'Created GitHub subscription.')
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: 'Created GitHub subscription.' }))
    })
    expect(element.textContent).toContain('Done')
    expect(element.textContent).toContain('Created GitHub subscription.')
    // A whole-store clear says nothing about this card, and another card's key is not ours.
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }))
      window.dispatchEvent(new StorageEvent('storage', { key: 'ac.native-ui.reported.other', newValue: 'x' }))
    })
    expect(element.textContent).toContain('Created GitHub subscription.')
  })

  it('records nothing when the conversation would not take the report', async () => {
    const value = app()
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={() => false} />)
    })
    await act(async () => element.querySelector('button')!.click())
    await act(async () => completionOf(0)('Created GitHub subscription.'))
    expect(localStorage.getItem(`ac.native-ui.reported.${value.appId}`)).toBeNull()
    expect(element.textContent).toContain('Configuration was saved, but the agent could not be notified.')
  })

  it('never calls a refused submit a save, even when the agent cannot be told', async () => {
    const value = app()
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={() => true} />)
    })
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value, outcome: 'completed' } }} onReport={() => true} />)
    })
    await act(async () => element.querySelector('button')!.click())
    await act(async () => completionOf(0)('Creating the agent failed: that name is taken', 'failed'))
    expect(element.textContent).toContain('Creating the agent failed')
    expect(element.textContent).not.toContain('changes are saved')
    expect(element.textContent).toContain('the agent was not told')
  })

  it('keeps a persisted card openable, and a history card waiting on nobody', async () => {
    const value = app()
    const restored = mcpAppCard(JSON.stringify(value))!
    expect(restored.nativeUi).toEqual(value.nativeUi)
    await act(async () => {
      root.render(<McpAppCard step={{ app: restored }} />)
    })
    // No way to report ⇒ no claim on the reader, but the configuration is still reachable.
    expect(element.querySelector('[data-native-app-status]')?.getAttribute('data-native-app-status')).toBe('inert')
    expect(element.textContent).not.toContain('Waiting')
    await act(async () => element.querySelector('button')!.click())
    expect(modal.openNativeIntegration).toHaveBeenCalledTimes(1)
  })

  it('closes an expired dialog but leaves a completed one alone for its final reveal step', async () => {
    const value = app()
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={() => true} />)
    })
    await act(async () => element.querySelector('button')!.click())
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value, outcome: 'completed' } }} onReport={() => true} />)
    })
    expect(modal.closeNativeIntegration).not.toHaveBeenCalled()
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value, outcome: 'expired' } }} onReport={() => true} />)
    })
    expect(modal.closeNativeIntegration).toHaveBeenCalledWith(value.appId)
  })

  it('does not close a reported dialog when its card then settles', async () => {
    const value = app()
    await act(async () => {
      root.render(<McpAppCard step={{ app: value }} onReport={() => true} />)
    })
    await act(async () => element.querySelector('button')!.click())
    await act(async () => completionOf(0)('Created webhook integration.'))
    await act(async () => {
      root.render(<McpAppCard step={{ app: { ...value, outcome: 'closed' } }} onReport={() => true} />)
    })
    expect(modal.closeNativeIntegration).not.toHaveBeenCalled()
  })
})
