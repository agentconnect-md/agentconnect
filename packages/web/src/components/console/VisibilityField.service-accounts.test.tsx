// @vitest-environment happy-dom

// A Selected audience may name a service account, so the picker lists it beside members and shows it once chosen.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberDto } from '@/lib/api'

const member = (userId: string, name: string, role: MemberDto['role'] = 'collaborator'): MemberDto => ({
  userId,
  email: `${name.toLowerCase()}@example.test`,
  name,
  picture: null,
  role,
  isCurrentUser: userId === 'u-alice',
  joinedAt: '2026-11-01T00:00:00Z'
})

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    members: [member('u-alice', 'Alice'), member('u-bob', 'Bob')],
    serviceAccounts: [{ ...member('sa-sync', 'sync-bot'), email: 'sync-bot-abc123@sa.agentconnect.md' }]
  })
}))

const { VisibilityField, VisibilityValue } = await import('./VisibilityField')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('a service account in a Selected audience', () => {
  it('is offered in the picker with its tag and picked like a member', () => {
    const onChange = vi.fn()
    act(() =>
      root.render(<VisibilityField value={{ visibility: 'restricted', sharedWith: ['u-alice'] }} onChange={onChange} />)
    )
    const input = host.querySelector('input')!
    act(() => input.focus())
    const option = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('sync-bot'))
    expect(option?.textContent).toContain('Service account')
    act(() => option!.click())
    expect(onChange).toHaveBeenCalledWith({ visibility: 'restricted', sharedWith: ['u-alice', 'sa-sync'] })
  })

  it('shows as a chip once it is in the audience', () => {
    act(() =>
      root.render(
        <VisibilityField value={{ visibility: 'restricted', sharedWith: ['u-alice', 'sa-sync'] }} onChange={() => {}} />
      )
    )
    const chips = [...host.querySelectorAll('span.rounded-full')].map((c) => c.textContent)
    expect(chips.some((text) => text?.includes('sync-bot'))).toBe(true)
  })

  it('counts in the read-only audience', () => {
    act(() => root.render(<VisibilityValue visibility="restricted" sharedWith={['sa-sync']} />))
    expect(host.querySelector('[title*="sync-bot"]')).not.toBeNull()
  })
})
