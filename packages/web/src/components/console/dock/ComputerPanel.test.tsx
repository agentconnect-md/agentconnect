// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computerFixture as computer } from '@/lib/computer-fixtures'
import type { ComputerViewerSession, ViewerDeps, ViewerState } from '@/lib/computer-viewer'
import { ComputerPanel } from './ComputerPanel'

const fetchComputer = vi.hoisted(() => vi.fn())
const fetchComputers = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  fetchComputer,
  fetchComputers
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const live: ViewerState = {
  phase: 'live',
  path: 'p2p',
  frameUrl: null,
  error: null,
  notes: [],
  status: {
    you: 'console:u1',
    mode: 'control',
    inControl: false,
    os: 'macos',
    status: 'online',
    paused: null,
    unavailable: null,
    lease: null,
    webrtc: { unavailable: null, error: null, turn: false }
  }
}

function fakeSession() {
  const fake = {
    deps: undefined as ViewerDeps | undefined,
    start: vi.fn(async () => fake.deps!.onState(live)),
    stop: vi.fn(),
    takeControl: vi.fn(async () => fake.deps!.onState({ ...live, status: { ...live.status!, inControl: true } })),
    release: vi.fn(async () => fake.deps!.onState(live)),
    send: vi.fn(async () => undefined)
  }
  const create = (deps: ViewerDeps) => {
    fake.deps = deps
    return fake as unknown as ComputerViewerSession
  }
  return { fake, create }
}

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  fetchComputer.mockReset()
  fetchComputers.mockReset()
})

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
  return host
}

const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)

describe('ComputerPanel', () => {
  it('watches the agent’s computer, expands it to the window and takes control', async () => {
    fetchComputer.mockImplementation(async (id: string) => computer({ id, name: 'macos.shared' }))
    const { fake, create } = fakeSession()
    const el = await render(<ComputerPanel computerIds={['c1']} active createSession={create} />)
    expect(el.textContent).toContain('macos.shared')
    await act(async () => button(el, 'Watch')!.click())
    expect(fake.start).toHaveBeenCalled()
    expect(fake.deps!.computerId).toBe('c1')

    const expand = el.querySelector('[data-viewer-expand] button') as HTMLButtonElement
    expect(expand.getAttribute('aria-label')).toBe('Expand')
    await act(async () => expand.click())
    // Expanded, the screen leaves the dock for the page body, out of the dock panel's stacking context.
    const overlay = document.querySelector('[data-viewer-expanded]')
    expect(overlay?.parentElement).toBe(document.body)
    expect(el.contains(overlay)).toBe(false)
    expect(fake.stop).not.toHaveBeenCalled()
    // A stream that arrives while expanded survives the way back, whichever control collapses the view.
    const stream = new MediaStream()
    overlay!.querySelector('video')!.srcObject = stream
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(el.querySelector('video')!.srcObject).toBe(stream)
    expect(document.querySelector('[data-viewer-expanded]')).toBeNull()
    expect(el.querySelector('[data-viewer-surface]')).not.toBeNull()

    await act(async () => button(el, 'Take control')!.click())
    expect(fake.takeControl).toHaveBeenCalled()
    expect(el.querySelector('[data-viewer-status]')!.textContent).toContain('You are in control')
  })

  it('stops streaming when the tab is hidden', async () => {
    fetchComputer.mockImplementation(async (id: string) => computer({ id }))
    const { fake, create } = fakeSession()
    const el = await render(<ComputerPanel computerIds={['c1']} active createSession={create} />)
    await act(async () => button(el, 'Watch')!.click())
    await act(async () => root!.render(<ComputerPanel computerIds={['c1']} active={false} createSession={create} />))
    expect(fake.stop).toHaveBeenCalled()
    expect(el.querySelector('[data-viewer-surface]')).toBeNull()
  })

  it('offers a choice between several computers and drops the ones the member cannot see', async () => {
    fetchComputer.mockImplementation(async (id: string) => {
      if (id === 'hidden') throw new Error('404')
      return computer({ id, name: id === 'a' ? 'mac' : 'linux' })
    })
    const el = await render(<ComputerPanel computerIds={['a', 'hidden', 'b']} active />)
    const options = [...el.querySelectorAll('option')].map((option) => option.textContent)
    expect(options).toEqual(['mac', 'linux'])
  })

  it('reads the computers again while shown, so an offline one becomes watchable and a failed read keeps the last', async () => {
    vi.useFakeTimers()
    try {
      let status: 'offline' | 'online' = 'offline'
      let failing = false
      fetchComputer.mockImplementation(async (id: string) => {
        if (failing) throw new Error('503')
        return computer({ id, status })
      })
      const el = await render(<ComputerPanel computerIds={['c1']} active />)
      expect(button(el, 'Watch')!.disabled).toBe(true)
      status = 'online'
      await act(async () => vi.advanceTimersByTimeAsync(15_000))
      expect(button(el, 'Watch')!.disabled).toBe(false)
      failing = true
      await act(async () => vi.advanceTimersByTimeAsync(15_000))
      expect(button(el, 'Watch')!.disabled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says so when none of the agent’s computers is visible', async () => {
    fetchComputer.mockRejectedValue(new Error('404'))
    const el = await render(<ComputerPanel computerIds={['hidden']} active />)
    expect(el.textContent).toContain('This agent has no computer you can watch.')
  })

  it('shows the agent’s pool computers: its kept one and this session’s, not another session’s', async () => {
    fetchComputer.mockImplementation(async (id: string) => computer({ id, name: 'granted' }))
    fetchComputers.mockResolvedValue([
      computer({ id: 'kept', name: 'kept', kind: 'managed', allocation: 'per-agent', ownerAgentId: 'a1' }),
      computer({
        id: 'mine',
        name: 'mine',
        kind: 'managed',
        allocation: 'ephemeral',
        ownerAgentId: 'a1',
        poolSessionId: 's1'
      }),
      computer({
        id: 'theirs',
        name: 'theirs',
        kind: 'managed',
        allocation: 'ephemeral',
        ownerAgentId: 'a1',
        poolSessionId: 's2'
      }),
      computer({ id: 'other', name: 'other', kind: 'managed', allocation: 'per-agent', ownerAgentId: 'a2' })
    ])
    const el = await render(<ComputerPanel computerIds={['g1']} managed={{ agentId: 'a1', sessionId: 's1' }} active />)
    const options = [...el.querySelectorAll('option')].map((option) => option.textContent)
    expect(options).toEqual(['granted', 'kept', 'mine'])
  })

  it('says the agent gets its computer on first use before the pool made one', async () => {
    fetchComputers.mockResolvedValue([])
    const el = await render(<ComputerPanel computerIds={[]} managed={{ agentId: 'a1', sessionId: 's1' }} active />)
    expect(el.textContent).toContain('The agent gets its computer when it first uses one in this session.')
  })
})
