// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nearBottom, useStickToBottom } from './stick-to-bottom'

// happy-dom has no layout engine, so the scroller's metrics are stubbed and the
// ResizeObserver callback is fired by hand — which is also what makes the ORDER
// under test explicit: latch on scroll, then grow, then follow.
let fireResize: (() => void) | undefined

// A real ResizeObserver stops calling back once the observed node leaves the
// document (it is no longer laid out), so the fake honours `isConnected` —
// without that, a subscription left on a detached node reads as healthy here and
// the swap regression below cannot fail.
class FakeResizeObserver {
  private nodes = new Set<Element>()
  constructor(private cb: () => void) {}
  observe(node: Element) {
    this.nodes.add(node)
    fireResize = () => {
      if ([...this.nodes].some((n) => n.isConnected)) this.cb()
    }
  }
  unobserve(node: Element) {
    this.nodes.delete(node)
  }
  disconnect() {
    this.nodes.clear()
    fireResize = undefined
  }
}

let reArm: (() => void) | undefined

function Probe({ resetKey }: { resetKey: string }) {
  reArm = useStickToBottom(resetKey)
  return null
}

let host: HTMLDivElement
let scroller: HTMLDivElement
let root: Root

/** Stub the layout the real transcript would have: `clientHeight` viewport over
 *  a `scrollHeight` of content. */
function setMetrics(scrollHeight: number, clientHeight = 500) {
  Object.defineProperty(scroller, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(scroller, 'clientHeight', { value: clientHeight, configurable: true })
}

/** The largest `scrollTop` the container allows — i.e. parked at the bottom. */
const bottom = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight)

beforeEach(() => {
  Reflect.set(globalThis, 'ResizeObserver', FakeResizeObserver)
  scroller = document.createElement('div')
  scroller.className = 'content'
  scroller.append(document.createElement('div')) // the view root — the box that grows
  document.body.append(scroller)
  // happy-dom stores `scrollTop` verbatim; a real scroller CLAMPS it. The clamp is
  // load-bearing here: the hook decides whether a pin actually moved the viewport
  // by reading the value back, and an unclamped stub makes a no-op pin look like a
  // real one.
  let top = 0
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, bottom()))
    },
    configurable: true
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  scroller.remove()
  fireResize = undefined
  reArm = undefined
})

describe('nearBottom', () => {
  it('counts a small gap as at-the-bottom and a large one as not', () => {
    setMetrics(2000)
    scroller.scrollTop = 1450 // 50px left
    expect(nearBottom(scroller)).toBe(true)
    scroller.scrollTop = 900 // 600px left
    expect(nearBottom(scroller)).toBe(false)
  })
})

describe('useStickToBottom', () => {
  it('follows growth for a reader parked at the bottom', () => {
    setMetrics(2000)
    scroller.scrollTop = bottom()
    act(() => root.render(<Probe resetKey="s1" />))
    act(() => scroller.dispatchEvent(new Event('scroll')))

    setMetrics(2600) // a new message lands
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(bottom())
  })

  it('leaves a reader who scrolled back through history alone', () => {
    setMetrics(2000)
    scroller.scrollTop = bottom()
    act(() => root.render(<Probe resetKey="s1" />))
    scroller.scrollTop = 200 // reader pages back
    act(() => scroller.dispatchEvent(new Event('scroll')))

    setMetrics(2600)
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(200)
  })

  it('arming against an already-long container parked at the top does not jump', () => {
    setMetrics(2000)
    scroller.scrollTop = 0 // never scrolled
    act(() => root.render(<Probe resetKey="s1" />))

    setMetrics(9000)
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(0)
  })

  // The real cold open: the view mounts (and arms) BEFORE the transcript loads,
  // so an empty container reads as at-the-bottom and the first history render
  // lands at the newest message. This is the intended landing, not a leak.
  it('follows a short transcript that never overflowed, with no scroll event', () => {
    setMetrics(300) // shorter than the 500px viewport
    scroller.scrollTop = 0
    act(() => root.render(<Probe resetKey="s1" />))

    setMetrics(900)
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(bottom())
  })

  it('re-latches on a session switch instead of carrying the old decision', () => {
    setMetrics(2000)
    scroller.scrollTop = bottom()
    act(() => root.render(<Probe resetKey="s1" />))
    act(() => scroller.dispatchEvent(new Event('scroll'))) // sticking

    scroller.scrollTop = 0 // the router resets scroll for the next session
    setMetrics(4000)
    act(() => root.render(<Probe resetKey="s2" />))
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(0)
  })
})

// The ordering that broke this in the real app: a pin's `scroll` event is
// delivered by the browser AFTER React has flushed the rows that prompted it, so
// measuring that event reads "far from the bottom" and un-arms the follow one
// beat after it was armed.
describe('useStickToBottom self-inflicted scroll', () => {
  it('survives the scroll echo of a re-arm pin delivered after the send renders', () => {
    setMetrics(2000)
    scroller.scrollTop = 200
    act(() => root.render(<Probe resetKey="s1" />))
    act(() => scroller.dispatchEvent(new Event('scroll'))) // reader is up in history

    act(() => reArm?.())
    setMetrics(2600) // the sent message renders BEFORE the echo lands
    act(() => scroller.dispatchEvent(new Event('scroll'))) // would read 100px from bottom

    setMetrics(3200) // the reply streams in
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(bottom())
  })

  it('survives echoes through progressive growth (the back-page prepend)', () => {
    setMetrics(300) // arms while the transcript is still empty
    scroller.scrollTop = 0
    act(() => root.render(<Probe resetKey="s1" />))

    setMetrics(3000)
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(bottom())

    setMetrics(6000) // the next page prepends before the echo lands
    act(() => scroller.dispatchEvent(new Event('scroll')))
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(bottom())
  })

  // Scroll events for one scroller COALESCE, so a pin's echo is not reliably
  // "the next event": anything that moves the viewport first arrives as that same
  // single event. Swallowing by position rather than by turn is what keeps these
  // from being mistaken for the echo.
  it('does not swallow the ?focus scrollIntoView that lands before the echo', () => {
    setMetrics(2000)
    scroller.scrollTop = bottom()
    act(() => root.render(<Probe resetKey="s1" />))
    act(() => scroller.dispatchEvent(new Event('scroll'))) // following

    setMetrics(3000) // history renders; the pin's echo is now pending
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(bottom())

    // The ?focus effect centres the linked participant's block, then the single
    // coalesced event is delivered from that new position.
    scroller.scrollTop = 300
    act(() => scroller.dispatchEvent(new Event('scroll')))

    setMetrics(3600) // more output must NOT drag the focused reader down
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(300)
  })

  it('does not swallow a user scroll that beats the echo of a re-arm pin', () => {
    setMetrics(2000)
    scroller.scrollTop = 200
    act(() => root.render(<Probe resetKey="s1" />))
    act(() => scroller.dispatchEvent(new Event('scroll')))

    act(() => reArm?.()) // pins to the bottom, echo pending
    scroller.scrollTop = 500 // the reader flicks back up before it is delivered
    act(() => scroller.dispatchEvent(new Event('scroll')))

    setMetrics(2600)
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(500)
  })

  it('still lets a real user scroll un-arm when the pin moved nothing', () => {
    setMetrics(2000)
    scroller.scrollTop = bottom() // already at the bottom: the pin is a no-op
    act(() => root.render(<Probe resetKey="s1" />))
    act(() => reArm?.())

    scroller.scrollTop = 100 // the reader pages back — must NOT be swallowed
    act(() => scroller.dispatchEvent(new Event('scroll')))
    setMetrics(2600)
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(100)
  })
})

describe('useStickToBottom re-arm on send', () => {
  it('follows again after a reader who paged back sends a message', () => {
    setMetrics(2000)
    scroller.scrollTop = bottom()
    act(() => root.render(<Probe resetKey="s1" />))
    scroller.scrollTop = 200 // reader pages back — follow is off
    act(() => scroller.dispatchEvent(new Event('scroll')))

    act(() => reArm?.())
    expect(scroller.scrollTop).toBe(bottom()) // jumps for the rows already there

    setMetrics(2600) // the sent message, then the reply
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(bottom())
  })

  it('does not re-arm across a session switch', () => {
    setMetrics(2000)
    scroller.scrollTop = bottom()
    act(() => root.render(<Probe resetKey="s1" />))
    act(() => reArm?.())

    scroller.scrollTop = 0 // the router resets scroll for the next session
    setMetrics(4000)
    act(() => root.render(<Probe resetKey="s2" />))
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(0)
  })
})

describe('useStickToBottom child swap', () => {
  it('keeps following after the loading placeholder is replaced by the real root', async () => {
    setMetrics(400)
    scroller.scrollTop = 0
    // A merged conversation keys on its URL, so resetKey is final from the first
    // frame while the tree is still the LoadingState placeholder.
    act(() => root.render(<Probe resetKey="/conversations/abc" />))

    // The roster resolves and the real view root replaces the placeholder —
    // same resetKey, so the effect does NOT re-run and the re-point has to come
    // from the swap watcher. Its callback is a microtask (a real browser also
    // runs it well before the next ResizeObserver delivery, which lands at the
    // end of the frame), so yield once before growing the content.
    await act(async () => {
      scroller.replaceChildren(document.createElement('div'))
    })
    setMetrics(3000)
    act(() => fireResize?.())
    expect(scroller.scrollTop).toBe(bottom())
  })
})
