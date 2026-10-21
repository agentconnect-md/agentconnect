// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computerFixture as computer } from '@/lib/computer-fixtures'
import type { ComputerViewerSession, ViewerDeps, ViewerState } from '@/lib/computer-viewer'
import { ComputerViewerCard } from './ComputerViewer'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const live: ViewerState = {
  phase: 'live',
  path: 'turn',
  frameUrl: null,
  error: null,
  notes: ['Direct: ICE failed'],
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

describe('ComputerViewerCard', () => {
  it('opens only for a live computer', () => {
    const off = render(<ComputerViewerCard computer={computer({ status: 'offline' })} />)
    expect(button(off, 'Watch')!.disabled).toBe(true)
    expect(off.textContent).toContain('The viewer opens once this computer is online.')
  })

  it('watches, takes over, sends keys and text, releases and closes', async () => {
    const { fake, create } = fakeSession()
    const el = render(<ComputerViewerCard computer={computer()} createSession={create} />)
    await act(async () => button(el, 'Watch')!.click())
    expect(fake.start).toHaveBeenCalled()
    expect(fake.deps!.computerId).toBe('c1')
    expect(el.querySelector('[data-viewer-path]')!.textContent).toContain('TURN relay')
    expect(el.querySelector('[data-viewer-status]')!.textContent).toContain('Watching')

    await act(async () => button(el, 'Take control')!.click())
    expect(el.querySelector('[data-viewer-status]')!.textContent).toContain('You are in control')
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

    await act(async () => button(el, 'Release')!.click())
    expect(fake.release).toHaveBeenCalled()
    act(() => button(el, 'Close')!.click())
    expect(fake.stop).toHaveBeenCalled()
  })

  it('shows a watch-only member no takeover', async () => {
    const { fake, create } = fakeSession()
    fake.start.mockImplementation(async () =>
      fake.deps!.onState({ ...live, status: { ...live.status!, mode: 'view' } })
    )
    const el = render(<ComputerViewerCard computer={computer()} createSession={create} />)
    await act(async () => button(el, 'Watch')!.click())
    expect(button(el, 'Take control')).toBeUndefined()
    expect(el.textContent).toContain('Watching only')
  })
})
