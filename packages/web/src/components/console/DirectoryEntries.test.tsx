// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/dynamic', () => ({
  default: () => (props: { content: string }) => <div data-testid="markdown">{props.content}</div>
}))

vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => false }))

vi.mock('@/lib/api', () => ({
  fetchMyAgentDirectoryEntry: vi.fn(),
  clearMyAgentDirectoryEntry: vi.fn(async () => ({ cleared: true })),
  fetchAgentDirectoryEntries: vi.fn(),
  clearAgentDirectoryEntry: vi.fn(async () => ({ cleared: true }))
}))

import {
  clearAgentDirectoryEntry,
  clearMyAgentDirectoryEntry,
  fetchAgentDirectoryEntries,
  fetchMyAgentDirectoryEntry
} from '@/lib/api'
import { DirectoryOwnerEntries, MyDirectoryEntry } from '@/components/console/DirectoryEntries'

const AGENT_ID = '22222222-2222-4222-8222-222222222222'
let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.clearAllMocks()
})

async function mount(node: React.ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(node))
  await act(async () => {
    await Promise.resolve()
  })
  return container
}

const button = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)

describe('MyDirectoryEntry', () => {
  it("shows the user's own entry and clears it after a confirmation", async () => {
    vi.mocked(fetchMyAgentDirectoryEntry).mockResolvedValue({
      entries: [{ key: 'user:me', text: '## Me `user:me`\nRole: tester (self, 2026-10-17)' }],
      clearable: true
    })
    const host = await mount(<MyDirectoryEntry agentId={AGENT_ID} />)
    expect(host.textContent).toContain('Your entry in the people directory')
    expect(host.querySelector('[data-testid="markdown"]')?.textContent).toContain('Role: tester')
    await act(async () => button('Clear entry')?.click())
    expect(document.body.textContent).toContain('Clear your entry?')
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.trim() === 'Clear entry'
    )
    await act(async () => confirm.at(-1)?.click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(clearMyAgentDirectoryEntry).toHaveBeenCalledWith(AGENT_ID)
    expect(host.querySelector('[data-my-directory-entry]')).toBeNull()
  })

  it('shows nothing when the agent keeps no entry for the user', async () => {
    vi.mocked(fetchMyAgentDirectoryEntry).mockResolvedValue({ entries: [], clearable: true })
    expect((await mount(<MyDirectoryEntry agentId={AGENT_ID} />)).innerHTML).toBe('')
  })
})

describe('DirectoryOwnerEntries', () => {
  it('lists the people with a Clear each for an owner, and clears the chosen one', async () => {
    vi.mocked(fetchAgentDirectoryEntries).mockResolvedValue({
      entries: [
        { key: 'slack:T0EXAMPLE:U0ALICE', name: 'Alice (@alice on Slack)' },
        { key: 'user:bob', name: 'Bob' }
      ],
      clearable: true
    })
    const host = await mount(<DirectoryOwnerEntries agentId={AGENT_ID} />)
    expect(host.textContent).toContain('People directory')
    expect(host.textContent).toContain('Alice (@alice on Slack)')
    const first = host.querySelectorAll<HTMLButtonElement>('button')[0]
    await act(async () => first?.click())
    expect(document.body.textContent).toContain('Clear this entry?')
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.trim() === 'Clear entry'
    )
    await act(async () => confirm.at(-1)?.click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(clearAgentDirectoryEntry).toHaveBeenCalledWith(AGENT_ID, 'slack:T0EXAMPLE:U0ALICE')
    expect(host.textContent).not.toContain('Alice')
    expect(host.textContent).toContain('Bob')
  })

  it('shows nothing to someone who may not clear an entry', async () => {
    vi.mocked(fetchAgentDirectoryEntries).mockResolvedValue({
      entries: [{ key: 'user:bob', name: 'Bob' }],
      clearable: false
    })
    expect((await mount(<DirectoryOwnerEntries agentId={AGENT_ID} />)).innerHTML).toBe('')
  })
})
