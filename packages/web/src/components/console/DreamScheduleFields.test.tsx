// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DreamScheduleFields } from './DreamScheduleFields'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

async function render(props: { value: string; timezone?: string; onChange?: (s: string, tz: string) => void }) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <DreamScheduleFields
        value={props.value}
        timezone={props.timezone ?? 'America/New_York'}
        onChange={props.onChange ?? (() => {})}
        disabled={false}
      />
    )
  })
  return container
}

const modeSelect = (host: HTMLElement) =>
  host.querySelector<HTMLSelectElement>('select[aria-label="Schedule frequency"]')
const cronInput = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[aria-label="Cron expression"]')

/** Fire a change the way React's controlled inputs expect. */
async function pick(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('DreamScheduleFields', () => {
  it('can enter Custom from a preset and mounts the raw expression input', async () => {
    // Regression: with the mode derived from the expression alone, choosing
    // Custom emitted a preset-shaped cron, parseCron read the preset back, and
    // the select snapped shut — Custom was unreachable.
    const host = await render({ value: '0 4 * * *' }) // a `daily` preset
    const select = modeSelect(host)!
    expect(select.value).toBe('daily')
    expect(cronInput(host)).toBeNull()

    await pick(select, 'custom')

    expect(modeSelect(host)!.value).toBe('custom')
    expect(cronInput(host)).not.toBeNull()
    // Switching to Custom must not rewrite what the user already had.
    expect(cronInput(host)!.value).toBe('0 4 * * *')
  })

  it('previews the next run in the schedule’s own timezone, not the browser’s', async () => {
    // A zone-less schedule cannot be previewed honestly — the daemon evaluates
    // it in its own host zone, which the console does not know.
    const noZone = await render({ value: '0 4 * * *', timezone: '' })
    expect(noZone.textContent).toContain('daemon host’s timezone')
    expect(noZone.textContent).not.toContain('next')
    await act(async () => root?.unmount())
    container?.remove()

    const zoned = await render({ value: '0 4 * * *', timezone: 'America/New_York' })
    expect(zoned.textContent).toContain('America/New_York')
    expect(zoned.textContent).toContain('next')
  })

  it('flags a timezone that is not a real IANA zone instead of previewing a wrong time', async () => {
    const host = await render({ value: '0 4 * * *', timezone: 'Pacific/Nowhere' })
    expect(host.textContent).toContain('not a known IANA timezone')
  })

  it('emits schedule and timezone together when toggled on', async () => {
    const onChange = vi.fn()
    const host = await render({ value: '', timezone: '', onChange })
    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => toggle.click())
    // A new schedule gets an explicit zone, so its preview is meaningful.
    expect(onChange).toHaveBeenCalledWith('0 4 * * *', expect.any(String))
    expect(onChange.mock.calls[0]![1]).not.toBe('')
  })
})
