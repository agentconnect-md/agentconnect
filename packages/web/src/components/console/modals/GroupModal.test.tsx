// @vitest-environment happy-dom
/**
 * The group's half of the two consents (session-executors.md §10): "Spread sessions across the
 * group" lets the group's agents run their isolated sessions on members other than their holder.
 * It lives beside the name and the membership because it is the group's own setting and this is
 * where a group is edited — and it is off until someone turns it on, since turning it on lends
 * every member's sign-in to the group's work.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberSetRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  createGroup: vi.fn(async (_name: string) => ({ setId: 'new-set' })),
  renameGroup: vi.fn(async () => {}),
  setGroupSpreadSessions: vi.fn(async () => {}),
  enrollInGroup: vi.fn(async () => {}),
  withdrawFromGroup: vi.fn(async () => {})
}))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ ...mocks, daemons: [] })
}))

const GroupModal = (await import('./GroupModal')).default

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const group = (over: Partial<MemberSetRow> = {}): MemberSetRow => ({
  setId: 'g1',
  name: 'build-farm',
  memberDaemonIds: [],
  agentCount: 0,
  spreadSessions: false,
  ...over
})

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(existing?: MemberSetRow) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<GroupModal group={existing} onClose={() => {}} />)
  })
}

const toggle = () => document.querySelector<HTMLButtonElement>('button[role="switch"]')!
const save = () =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save' || b.textContent === 'Create group')!
const click = (el: HTMLElement) => act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))

/** React tracks the DOM value it wrote, so a raw assignment is swallowed. */
const typeName = (value: string) =>
  act(async () => {
    const field = document.querySelector<HTMLInputElement>('input.inp')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('GroupModal — spreading sessions across the group', () => {
  it('offers the switch off for a group that has never had it on', async () => {
    await render(group())

    expect(host!.textContent).toContain('Spread sessions across the group')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(host!.textContent).toContain('Off')
  })

  it('reads the switch from the group, and leaves it alone when nothing about it changed', async () => {
    await render(group({ spreadSessions: true }))
    expect(toggle().getAttribute('aria-checked')).toBe('true')

    await click(save())

    expect(mocks.setGroupSpreadSessions).not.toHaveBeenCalled()
  })

  it('applies a flipped switch on save, like every other field in the dialog', async () => {
    await render(group())

    await click(toggle())
    expect(host!.textContent).toContain('On')
    await click(save())

    expect(mocks.setGroupSpreadSessions).toHaveBeenCalledWith('g1', true)
  })

  it('applies it to a group the dialog has just created', async () => {
    await render()

    await typeName('build-farm')
    await click(toggle())
    await click(save())

    expect(mocks.createGroup).toHaveBeenCalled()
    expect(mocks.setGroupSpreadSessions).toHaveBeenCalledWith('new-set', true)
  })
})
