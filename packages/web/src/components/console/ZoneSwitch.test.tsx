// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZoneSwitch } from './ZoneSwitch'
import {
  browserTimeZone,
  displayTimeZone,
  type ScheduleTimeZone,
  type ScheduleTimeZoneMode
} from '@/lib/schedule-timezone'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** A hook stand-in: the hook itself is covered in `lib/schedule-timezone.test.ts`. */
function clockOf(mode: ScheduleTimeZoneMode, ready = true, setMode = vi.fn()): ScheduleTimeZone {
  return { mode, ready, setMode, zoneFor: (zone) => displayTimeZone(mode, zone) }
}

const OTHER = browserTimeZone() === 'UTC' ? 'Asia/Tokyo' : 'UTC'

const render = (element: React.ReactElement) => act(() => root.render(element))
const button = () => host.querySelector('button')

describe('ZoneSwitch', () => {
  it('offers the schedule’s clock, naming the one currently in use', () => {
    render(<ZoneSwitch clock={clockOf('browser')} scheduleZone={OTHER} />)

    expect(button()?.textContent).toContain(browserTimeZone())
    expect(button()?.getAttribute('title')).toBe(`Times shown in ${browserTimeZone()} — switch to ${OTHER}`)
  })

  it('names the schedule’s clock once that is the one in use', () => {
    render(<ZoneSwitch clock={clockOf('schedule')} scheduleZone={OTHER} />)

    expect(button()?.textContent).toContain(OTHER)
    expect(button()?.getAttribute('title')).toBe(`Times shown in ${OTHER} — switch to ${browserTimeZone()}`)
  })

  it('switches to the other clock on click', () => {
    const setMode = vi.fn()
    render(<ZoneSwitch clock={clockOf('browser', true, setMode)} scheduleZone={OTHER} />)
    act(() => button()?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(setMode).toHaveBeenCalledWith('schedule')
  })

  it('renders nothing when both readings would be the same text', () => {
    render(<ZoneSwitch clock={clockOf('browser')} scheduleZone={browserTimeZone()} />)
    expect(button()).toBeNull()

    render(<ZoneSwitch clock={clockOf('browser')} scheduleZone={null} />)
    expect(button()).toBeNull()
  })

  it('waits for the hook, since the viewer’s zone is unknown before mount', () => {
    render(<ZoneSwitch clock={clockOf('browser', false)} scheduleZone={OTHER} />)
    expect(button()).toBeNull()
  })
})
