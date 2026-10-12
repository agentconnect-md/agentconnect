// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Scrim } from './Scrim'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement | undefined
let root: Root | undefined

function render(ui: React.ReactNode) {
  host ??= document.body.appendChild(document.createElement('div'))
  root ??= createRoot(host)
  act(() => root!.render(ui))
}

function press(init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, ...init })
  act(() => void window.dispatchEvent(event))
  return event
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('Scrim', () => {
  it('dismisses only the topmost layer on Escape', () => {
    const lower = vi.fn()
    const upper = vi.fn()
    render(
      <>
        <Scrim onEscape={lower}>lower</Scrim>
        {null}
      </>
    )
    render(
      <>
        <Scrim onEscape={lower}>lower</Scrim>
        <Scrim onEscape={upper}>upper</Scrim>
      </>
    )
    press()
    expect(upper).toHaveBeenCalledTimes(1)
    expect(lower).not.toHaveBeenCalled()

    render(
      <>
        <Scrim onEscape={lower}>lower</Scrim>
        {null}
      </>
    )
    press()
    expect(lower).toHaveBeenCalledTimes(1)
  })

  it('swallows Escape for a busy top layer instead of reaching the one beneath', () => {
    const lower = vi.fn()
    render(
      <>
        <Scrim onEscape={lower}>lower</Scrim>
        {null}
      </>
    )
    render(
      <>
        <Scrim onEscape={lower}>lower</Scrim>
        <Scrim onEscape={undefined}>busy</Scrim>
      </>
    )
    press()
    expect(lower).not.toHaveBeenCalled()
  })

  it('leaves Escape to an inner menu that claimed it, and to IME composition', () => {
    const onEscape = vi.fn()
    render(<Scrim onEscape={onEscape}>dialog</Scrim>)
    const claimed = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    claimed.preventDefault()
    act(() => void window.dispatchEvent(claimed))
    press({ isComposing: true })
    expect(onEscape).not.toHaveBeenCalled()
    press()
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('uses the latest handler without re-stacking', () => {
    const first = vi.fn()
    const second = vi.fn()
    render(<Scrim onEscape={first}>dialog</Scrim>)
    render(<Scrim onEscape={second}>dialog</Scrim>)
    press()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('ignores a click whose press began inside the dialog', () => {
    const onClick = vi.fn()
    render(
      <Scrim onEscape={undefined} onClick={onClick}>
        <textarea />
      </Scrim>
    )
    const scrim = host!.querySelector<HTMLElement>('.scrim')!
    act(() => {
      host!.querySelector('textarea')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      scrim.click()
    })
    expect(onClick).not.toHaveBeenCalled()
    act(() => {
      scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      scrim.click()
    })
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
