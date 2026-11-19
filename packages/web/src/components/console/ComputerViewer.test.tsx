// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computerFixture as computer } from '@/lib/computer-fixtures'
import type { ComputerViewerSession, ViewerDeps, ViewerState } from '@/lib/computer-viewer'
import { ComputerViewerCard, ComputerViewerScreen, formatStats } from './ComputerViewer'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const live: ViewerState = {
  phase: 'live',
  path: 'turn',
  frameUrl: null,
  error: null,
  notes: ['Direct: ICE failed'],
  stats: null,
  status: {
    you: 'console:u1',
    mode: 'control',
    inControl: false,
    os: 'linux',
    status: 'online',
    paused: null,
    unavailable: null,
    lease: null,
    webrtc: { unavailable: null, error: null, turn: true }
  }
}

// A session double: the card drives it, and the test plays the desktop's state changes through `deps.onState`.
function fakeSession() {
  const fake = {
    deps: undefined as ViewerDeps | undefined,
    start: vi.fn(async () => fake.deps!.onState(live)),
    stop: vi.fn(),
    takeControl: vi.fn(async () => fake.deps!.onState({ ...live, status: { ...live.status!, inControl: true } })),
    release: vi.fn(async () => fake.deps!.onState(live)),
    send: vi.fn(async () => undefined),
    browserAction: vi.fn(async () => true)
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
})

function render(node: React.ReactNode): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(node))
  return host
}

const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)

const browser = {
  available: true,
  running: true,
  pages: [
    { id: 'page-a', title: 'Example', url: 'https://example.test/' },
    { id: 'page-b', title: 'Second tab', url: 'https://example.test/second' }
  ],
  frontPageId: 'page-a',
  dialog: null
}

describe('ComputerViewerCard', () => {
  it('starts on Desktop and opens an address in Browser before Chrome is running', async () => {
    const { fake, create } = fakeSession()
    const absent = { ...browser, running: false, pages: [], frontPageId: null }
    fake.start.mockImplementation(async () => fake.deps!.onState({ ...live, browser: absent }))
    const el = render(<ComputerViewerCard computer={computer({ isolation: 'container' })} createSession={create} />)
    await act(async () => button(el, 'Watch')!.click())
    expect(button(el, 'Desktop')!.getAttribute('aria-pressed')).toBe('true')
    expect(fake.deps!.probeBrowser).toBe(true)
    await act(async () => button(el, 'Browser')!.click())
    expect(fake.deps!.browser?.maxWidth).toBe(1280)
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Address"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'example.test')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button(el, 'Open')!.click())
    expect(fake.browserAction).toHaveBeenCalledWith({ action: 'open', url: 'example.test' })
    await act(async () => button(el, 'Desktop')!.click())
    expect(fake.deps!.browser).toBeUndefined()
  })

  it('prefers Browser in the agent panel, selects tabs from the mobile picker, and responds to a page prompt', async () => {
    const { fake, create } = fakeSession()
    fake.start.mockImplementation(async () => fake.deps!.onState({ ...live, browser }))
    const el = render(
      <ComputerViewerScreen
        computer={computer({ isolation: 'container' })}
        desktop="agent-desktop"
        compact
        preferBrowser
        createSession={create}
      />
    )
    expect(button(el, 'Browser')!.getAttribute('aria-pressed')).toBe('true')
    expect(fake.deps).toMatchObject({ desktop: 'agent-desktop', browser: { maxWidth: 640 } })
    const picker = el.querySelector<HTMLSelectElement>('select[aria-label="Tabs"]')!
    expect(picker.options[0]!.textContent).toBe('2 tabs')
    await act(async () => {
      picker.value = 'page-b'
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(fake.browserAction).toHaveBeenCalledWith({ action: 'select', pageId: 'page-b' })
    act(() =>
      fake.deps!.onState({
        ...live,
        browser: { ...browser, dialog: { type: 'prompt', message: 'Name?', defaultPrompt: 'Example' } }
      })
    )
    expect(el.querySelector('[role="dialog"]')!.textContent).toContain('Name?')
    await act(async () => button(el, 'OK')!.click())
    expect(fake.browserAction).toHaveBeenCalledWith({ action: 'dialog', accept: true, text: 'Example' })
    await act(async () => button(el, 'Desktop')!.click())
    expect(button(el, 'Desktop')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('opens only for a live computer', () => {
    const off = render(<ComputerViewerCard computer={computer({ status: 'offline' })} />)
    expect(button(off, 'Watch')!.disabled).toBe(true)
    expect(off.textContent).toContain('Offline. Last seen')
    const asleep = render(<ComputerViewerCard computer={computer({ status: 'sleeping' })} />)
    expect(button(asleep, 'Watch')!.disabled).toBe(true)
    expect(asleep.textContent).toContain('Asleep.')
  })

  it('sends the next hover move only after the previous one is applied', async () => {
    const { fake, create } = fakeSession()
    let applied: () => void = () => undefined
    fake.send.mockImplementation(() => new Promise<undefined>((resolve) => (applied = () => resolve(undefined))))
    const el = render(<ComputerViewerCard computer={computer()} createSession={create} />)
    await act(async () => button(el, 'Watch')!.click())
    await act(async () => button(el, 'Take control')!.click())
    const surface = el.querySelector<HTMLDivElement>('[data-viewer-surface]')!
    const hover = () =>
      surface.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', bubbles: true, clientX: 1 }))
    act(() => {
      for (let i = 0; i < 5; i++) hover()
    })
    // A slow round trip must not build a backlog that later input waits behind.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 120)))
    expect(fake.send).toHaveBeenCalledTimes(1)
    await act(async () => applied())
    expect(fake.send).toHaveBeenCalledTimes(2)
    await act(async () => applied())
    expect(fake.send).toHaveBeenCalledTimes(2)
  })

  it('watches, takes over, sends keys and text, releases and closes', async () => {
    const { fake, create } = fakeSession()
    const el = render(<ComputerViewerCard computer={computer()} createSession={create} />)
    await act(async () => button(el, 'Watch')!.click())
    expect(fake.start).toHaveBeenCalled()
    expect(fake.deps!.computerId).toBe('c1')
    expect(el.querySelector('[data-viewer-path]')!.textContent).toContain('TURN relay')
    expect(el.querySelector('[data-viewer-status]')!.textContent).toBe('Live')
    expect(el.querySelector<HTMLElement>('[data-viewer-status]')!.title).toContain('Watching')

    await act(async () => button(el, 'Take control')!.click())
    expect(el.querySelector('[data-viewer-status]')!.textContent).toBe('Controlling')
    expect(el.textContent).toContain('Agents are paused until you hand back')
    const surface = el.querySelector<HTMLDivElement>('[data-viewer-surface]')!
    act(() => {
      surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(fake.send).toHaveBeenCalledWith({ type: 'key', keys: ['return'] })
    const input = el.querySelector<HTMLInputElement>('input')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '上海')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button(el, 'Send')!.click())
    expect(fake.send).toHaveBeenCalledWith({ type: 'type', text: '上海' })

    await act(async () => button(el, 'Hand back')!.click())
    expect(fake.release).toHaveBeenCalled()
    act(() => button(el, 'Stop watching')!.click())
    expect(fake.stop).toHaveBeenCalled()
  })

  it('shows what the stream delivers beside the path, leaving out what it cannot measure', async () => {
    const { fake, create } = fakeSession()
    const el = render(<ComputerViewerCard computer={computer()} createSession={create} />)
    await act(async () => button(el, 'Watch')!.click())
    expect(el.querySelector('[data-viewer-stats]')).toBeNull()
    act(() => fake.deps!.onState({ ...live, stats: { fps: 30, kbps: 2412, latencyMs: 41 } }))
    const stats = el.querySelector<HTMLElement>('[data-viewer-stats]')!
    expect(stats.textContent).toBe('30 fps · 2.4 Mbps · 41 ms')
    expect(stats.title).toContain('round trip')
    act(() => fake.deps!.onState({ ...live, path: 'screenshots', stats: { fps: 3, kbps: 850, latencyMs: 320 } }))
    expect(el.querySelector<HTMLElement>('[data-viewer-stats]')!.title).toContain('fetch one screenshot')
    expect(formatStats({ fps: null, kbps: 999, latencyMs: null })).toBe('999 kbps')
  })

  it('shows a watch-only member no takeover', async () => {
    const { fake, create } = fakeSession()
    fake.start.mockImplementation(async () =>
      fake.deps!.onState({ ...live, status: { ...live.status!, mode: 'view' } })
    )
    const el = render(<ComputerViewerCard computer={computer()} createSession={create} />)
    await act(async () => button(el, 'Watch')!.click())
    expect(button(el, 'Take control')).toBeUndefined()
    expect(el.querySelector<HTMLElement>('[data-viewer-status]')!.title).toContain('Watching only')
  })
})
