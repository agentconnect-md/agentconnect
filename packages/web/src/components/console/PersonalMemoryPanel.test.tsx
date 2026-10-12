// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/dynamic', () => ({
  default: () => (props: { content: string }) => <div data-testid="markdown">{props.content}</div>
}))

vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => false }))

vi.mock('@/lib/api', () => ({
  listMyAgentMemory: vi.fn(),
  fetchMyAgentMemoryFull: vi.fn()
}))

import { fetchMyAgentMemoryFull, listMyAgentMemory } from '@/lib/api'
import { PersonalMemoryPanel } from '@/components/console/PersonalMemoryPanel'

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

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<PersonalMemoryPanel agentId={AGENT_ID} />))
  await act(async () => {
    await Promise.resolve()
  })
  return container
}

describe('PersonalMemoryPanel', () => {
  it("lists the signed-in user's own memory and opens a file read-only", async () => {
    vi.mocked(listMyAgentMemory).mockResolvedValue({
      exists: true,
      files: [{ name: 'prefs.md', size: 12, mtime: '2026-07-07T00:00:00.000Z' }]
    })
    vi.mocked(fetchMyAgentMemoryFull).mockResolvedValue({
      exists: true,
      content: '- likes tabs',
      mtime: '2026-07-07T00:00:00.000Z'
    })
    const host = await mount()
    expect(host.textContent).toContain('Your memory')
    const row = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('prefs.md'))
    await act(async () => row?.click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchMyAgentMemoryFull).toHaveBeenCalledWith(AGENT_ID, 'prefs.md')
    expect(host.querySelector('[data-testid="markdown"]')?.textContent).toBe('- likes tabs')
    // Read-only: nothing here edits or saves.
    expect([...host.querySelectorAll('button')].some((b) => /edit|save|delete/i.test(b.textContent ?? ''))).toBe(false)
  })

  it('says when the agent keeps nothing for you, and when your memory cannot be read', async () => {
    vi.mocked(listMyAgentMemory).mockResolvedValueOnce({ exists: false, files: [] })
    expect((await mount()).textContent).toContain('The agent keeps nothing for you yet.')
    act(() => root?.unmount())
    container?.remove()
    vi.mocked(listMyAgentMemory).mockRejectedValueOnce(new Error('503'))
    expect((await mount()).textContent).toContain("Your memory can't be read right now.")
  })
})
