// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingActionsBanner, PendingActionsProvider, usePendingAction } from './PendingActions'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// happy-dom has no IntersectionObserver: this one records every observed node and lets a test say
// what the scroller can see, which is the only thing the banner reads.
let visible: (nodes: Element[]) => void = () => {}
class FakeObserver {
  static live: FakeObserver[] = []
  nodes: Element[] = []
  constructor(private readonly fire: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
    FakeObserver.live.push(this)
  }
  observe(node: Element) {
    this.nodes.push(node)
  }
  disconnect() {
    FakeObserver.live = FakeObserver.live.filter((o) => o !== this)
  }
  show(shown: Element[]) {
    this.fire(this.nodes.map((target) => ({ target, isIntersecting: shown.includes(target) })))
  }
}

function Waiter({ id, label, waiting }: { id: string; label: string; waiting: boolean }) {
  const ref = usePendingAction(id, label, waiting)
  return <div ref={ref} data-waiter={id} />
}

let element: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  FakeObserver.live = []
  vi.stubGlobal(
    'IntersectionObserver',
    class extends FakeObserver {
      constructor(fire: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
        super(fire)
      }
    }
  )
  visible = (nodes) => act(() => FakeObserver.live.forEach((o) => o.show(nodes)))
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(() => {
  act(() => root.unmount())
  element.remove()
  vi.unstubAllGlobals()
})

const banner = () => element.querySelector('button')

describe('the waiting banner', () => {
  it('stays out of the way while the card it would name is on screen', async () => {
    await act(async () => {
      root.render(
        <PendingActionsProvider>
          <PendingActionsBanner />
          <Waiter id="a" label="Create agent" waiting />
        </PendingActionsProvider>
      )
    })
    expect(banner()).toBeNull()
    visible([element.querySelector('[data-waiter="a"]')!])
    expect(banner()).toBeNull()
  })

  it('names a card scrolled out of sight, and scrolls back to it', async () => {
    await act(async () => {
      root.render(
        <PendingActionsProvider>
          <PendingActionsBanner />
          <Waiter id="a" label="Create agent" waiting />
        </PendingActionsProvider>
      )
    })
    const card = element.querySelector('[data-waiter="a"]') as HTMLElement
    const scrollIntoView = vi.fn()
    card.scrollIntoView = scrollIntoView
    visible([])
    expect(banner()?.textContent).toContain('Create agent is waiting for your action')
    act(() => banner()!.click())
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('counts the rest and names the first in transcript order', async () => {
    await act(async () => {
      root.render(
        <PendingActionsProvider>
          <PendingActionsBanner />
          <Waiter id="a" label="A question" waiting />
          <Waiter id="b" label="Create agent" waiting />
        </PendingActionsProvider>
      )
    })
    visible([])
    expect(banner()?.textContent).toContain('A question is waiting for your action')
    expect(banner()?.textContent).toContain('(+1 more)')
  })

  // The live-to-persisted transition remounts the card under the SAME action key: React detaches
  // the old ref and attaches the new one in one commit, so the key list nets out identical. A
  // snapshot that tracked only keys left the observer on the detached node and quietly stopped
  // counting a card that is still waiting.
  it('follows the node when a waiting card is remounted under the same key', async () => {
    const render = (instance: number) =>
      act(() => {
        root.render(
          <PendingActionsProvider>
            <PendingActionsBanner />
            <Waiter key={instance} id="a" label="Create agent" waiting />
          </PendingActionsProvider>
        )
      })
    await render(1)
    visible([])
    expect(banner()).not.toBeNull()
    const before = element.querySelector('[data-waiter="a"]')
    await render(2)
    const after = element.querySelector('[data-waiter="a"]')
    expect(after).not.toBe(before)
    visible([])
    expect(banner()?.textContent).toContain('Create agent is waiting for your action')
    // And the banner's button now reaches the node that is actually on the page.
    const scrollIntoView = vi.fn()
    ;(after as HTMLElement).scrollIntoView = scrollIntoView
    act(() => banner()!.click())
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('drops an item the moment it stops waiting', async () => {
    const render = (waiting: boolean) =>
      act(() => {
        root.render(
          <PendingActionsProvider>
            <PendingActionsBanner />
            <Waiter id="a" label="Create agent" waiting={waiting} />
          </PendingActionsProvider>
        )
      })
    await render(true)
    visible([])
    expect(banner()).not.toBeNull()
    await render(false)
    expect(banner()).toBeNull()
  })

  it('registers nothing outside a provider', async () => {
    await act(async () => {
      root.render(<Waiter id="a" label="Create agent" waiting />)
    })
    expect(element.querySelector('[data-waiter="a"]')).not.toBeNull()
  })
})
