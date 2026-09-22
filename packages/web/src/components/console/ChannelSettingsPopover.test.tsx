// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelSettingsPopover, type ChannelSettingsGroup } from './ChannelSettingsPopover'

const RESPOND = [
  { value: 'mention', label: '@-mentions', hint: 'Replies when @-mentioned.' },
  { value: 'any', label: 'All messages', hint: 'Replies to every message.' },
  { value: 'off', label: 'Off', hint: 'Stays but never replies.' }
]
const SESSION = [
  { value: 'createNew', label: 'Per thread', hint: 'Each thread has its own session.' },
  { value: 'append', label: 'Single session', hint: 'One session, shared across threads.' }
]

/** Stands in for the console data: the value moves once `save` resolves, and a refused write rejects. */
function Harness({
  save,
  disabled = false
}: {
  save: (group: string, value: string) => Promise<void>
  disabled?: boolean
}) {
  const [trigger, setTrigger] = useState('mention')
  const [session, setSession] = useState('createNew')
  const groups: ChannelSettingsGroup[] = [
    {
      id: 'trigger',
      label: 'Respond to',
      options: RESPOND,
      value: trigger,
      onPick: async (value) => {
        await save('trigger', value)
        setTrigger(value)
      }
    },
    {
      id: 'session',
      label: 'Session mode',
      options: SESSION,
      value: session,
      summarize: (chosen) => chosen.trigger !== 'off',
      onPick: async (value) => {
        await save('session', value)
        setSession(value)
      }
    }
  ]
  return <ChannelSettingsPopover groups={groups} name="deploys" disabled={disabled} />
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const button = () => host.querySelector('button')!
const menu = () => document.body.querySelector<HTMLElement>('[data-anchored-flyout]')
const options = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
const option = (label: string) => options().find((o) => o.textContent === label)!
const checked = () =>
  options()
    .filter((o) => o.getAttribute('aria-checked') === 'true')
    .map((o) => o.textContent)
// The footer stacks every description in one cell and shows one per group.
const described = () =>
  [...(menu()?.querySelectorAll<HTMLElement>('[aria-hidden="true"] span[id]') ?? [])]
    .filter((s) => !s.className.includes('invisible'))
    .map((s) => s.textContent)

function deferred() {
  let resolve!: () => void
  let reject!: (cause: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const saved = async () => {}
const alertText = () => menu()?.querySelector('[role="alert"]')?.textContent ?? null

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('ChannelSettingsPopover', () => {
  it('reads both choices on the closed button and opens them as two labelled radio groups', () => {
    act(() => root.render(<Harness save={saved} />))

    expect(button().getAttribute('aria-label')).toBe('Settings for deploys: @-mentions, Per thread')
    expect(button().getAttribute('title')).toBe('Respond to · Session mode')
    expect(menu()).toBeNull()

    act(() => button().click())
    expect(menu()?.getAttribute('aria-label')).toBe('Settings for deploys')
    expect(button().getAttribute('aria-expanded')).toBe('true')
    const groups = [...menu()!.querySelectorAll('[role="group"]')].map(
      (g) => document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent
    )
    expect(groups).toEqual(['Respond to', 'Session mode'])
    expect(options().map((o) => o.textContent)).toEqual([
      '@-mentions',
      'All messages',
      'Off',
      'Per thread',
      'Single session'
    ])
    expect(checked()).toEqual(['@-mentions', 'Per thread'])
  })

  it('saves a pick at once and stays open, showing it before the save settles', async () => {
    const pending = deferred()
    const save = vi.fn(() => pending.promise)
    act(() => root.render(<Harness save={save} />))
    act(() => button().click())

    act(() => option('All messages').click())
    expect(save).toHaveBeenCalledWith('trigger', 'any')
    expect(menu()).not.toBeNull()
    expect(checked()).toEqual(['All messages', 'Per thread'])

    // One write per group at a time: a second pick waits for the first to land.
    act(() => option('Off').click())
    expect(save).toHaveBeenCalledTimes(1)
    // The other group is free.
    act(() => option('Single session').click())
    expect(save).toHaveBeenLastCalledWith('session', 'append')

    await act(async () => pending.resolve())
    await settle()
    expect(menu()).not.toBeNull()
    expect(checked()).toEqual(['All messages', 'Single session'])
    expect(button().getAttribute('aria-label')).toBe('Settings for deploys: All messages, Single session')
    expect(alertText()).toBeNull()
  })

  it('tells a refused save inside the popover and returns to the saved choice', async () => {
    const refused = deferred()
    const save = vi.fn(() => refused.promise)
    act(() => root.render(<Harness save={save} />))
    act(() => button().click())

    act(() => option('Single session').click())
    expect(checked()).toEqual(['@-mentions', 'Single session'])
    await act(async () => refused.reject(new Error('forbidden: editor access required')))
    await settle()
    expect(menu()).not.toBeNull()
    expect(checked()).toEqual(['@-mentions', 'Per thread'])
    expect(alertText()).toBe('forbidden: editor access required')

    // The next pick starts clean…
    save.mockImplementation(saved)
    act(() => option('Off').click())
    expect(alertText()).toBeNull()
  })

  it('opens clean after a refused save', async () => {
    act(() => root.render(<Harness save={() => Promise.reject(new Error('offline'))} />))
    act(() => button().click())
    act(() => option('All messages').click())
    await settle()
    expect(alertText()).toBe('offline')

    act(() => button().click())
    expect(menu()).toBeNull()
    act(() => button().click())
    expect(alertText()).toBeNull()
  })

  it('leaves the session mode unsaid on the button as soon as Off is picked', () => {
    act(() => root.render(<Harness save={() => new Promise<void>(() => {})} />))
    act(() => button().click())

    act(() => option('Off').click())
    expect(button().getAttribute('aria-label')).toBe('Settings for deploys: Off')
    expect(button().textContent).not.toContain('Per thread')
    // The popover still offers the mode for when the row is back on.
    expect(options().map((o) => o.textContent)).toContain('Per thread')
  })

  it('describes the option under focus, else the chosen one, in each group', () => {
    act(() => root.render(<Harness save={saved} />))
    act(() => button().click())

    expect(described()).toEqual([
      '@-mentions — Replies when @-mentioned.',
      'Per thread — Each thread has its own session.'
    ])
    act(() => option('Off').focus())
    expect(described()).toEqual(['Off — Stays but never replies.', 'Per thread — Each thread has its own session.'])
    act(() => option('Off').blur())
    expect(described()[0]).toBe('@-mentions — Replies when @-mentioned.')

    // Assistive tech reads the same sentence off the option itself.
    const append = option('Single session')
    expect(document.getElementById(append.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Single session — One session, shared across threads.'
    )
  })

  it('stays shut on a demo row', () => {
    const save = vi.fn(saved)
    act(() => root.render(<Harness save={save} disabled />))

    expect(button().disabled).toBe(true)
    act(() => button().click())
    expect(menu()).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })
})
