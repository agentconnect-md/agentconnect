// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ isMobile: false }))

vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => mocks.isMobile }))
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public status = 500,
      public code?: string
    ) {
      super(message)
    }
  }
  return {
    ApiError,
    fetchAgentMemoryFull: vi.fn(),
    listAgentMemory: vi.fn(),
    updateAgentMemory: vi.fn()
  }
})

import { fetchAgentMemoryFull, listAgentMemory, updateAgentMemory } from '@/lib/api'
import { NativeMemoryFiles } from './NativeMemoryFiles'

const AGENT = '22222222-2222-4222-8222-222222222222'
let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

beforeEach(() => {
  mocks.isMobile = false
  vi.mocked(listAgentMemory)
    .mockReset()
    .mockResolvedValue({ exists: true, files: [{ name: 'MEMORY.md', size: 9, mtime: '2026-07-27T09:00:00.000Z' }] })
  vi.mocked(fetchAgentMemoryFull)
    .mockReset()
    .mockResolvedValue({ exists: true, content: '# Memory', mtime: '2026-07-27T09:00:00.000Z' })
  vi.mocked(updateAgentMemory)
    .mockReset()
    .mockResolvedValue({ path: 'MEMORY.md', size: 9, mtime: '2026-07-27T09:01:00.000Z' })
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.unstubAllGlobals()
})

const mount = async (canEdit = true) => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<NativeMemoryFiles agentId={AGENT} canEdit={canEdit} />)
    await Promise.resolve()
  })
  return container
}

const clickButton = async (host: HTMLElement, label: string) => {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(button, `${label} button`).toBeTruthy()
  await act(async () => button?.click())
}

const changeValue = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('NativeMemoryFiles', () => {
  it('lists the runtime’s files, opens the index first, and shows its size in the summary row', async () => {
    const host = await mount()
    expect(listAgentMemory).toHaveBeenCalledWith(AGENT)
    expect(fetchAgentMemoryFull).toHaveBeenCalledWith(AGENT, undefined)
    expect(host.textContent).toContain('MEMORY.md')
    expect(host.querySelector('.h-\\[37px\\]')?.textContent).toContain('9 B')
    // The runtime owns the log of its own memory: no History control here.
    expect(host.textContent).not.toContain('History')
  })

  it('uses the shared inline add flow instead of a browser prompt', async () => {
    const prompt = vi.fn(() => 'legacy.md')
    vi.stubGlobal('prompt', prompt)
    const host = await mount()

    await clickButton(host, 'Add file')
    expect(prompt).not.toHaveBeenCalled()
    const name = host.querySelector<HTMLInputElement>('input[aria-label="New memory file name"]')
    const content = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="New file content"]')
    expect(name?.closest('.cardhead')).not.toBeNull()
    expect(content?.closest('.card')).not.toBeNull()

    await changeValue(name!, 'deploys.md')
    await changeValue(content!, '# Deploys')
    await clickButton(host, 'Save changes')
    expect(updateAgentMemory).toHaveBeenCalledWith(AGENT, '# Deploys', 'deploys.md', undefined)
  })

  it('refuses a nested or non-Markdown file name before saving', async () => {
    const host = await mount()
    await clickButton(host, 'Add file')
    await changeValue(host.querySelector<HTMLInputElement>('input[aria-label="New memory file name"]')!, 'notes/a.txt')
    await changeValue(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="New file content"]')!, 'x')
    await clickButton(host, 'Save changes')
    expect(updateAgentMemory).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Use a flat .md file name')
  })

  it('offers no editing controls to a viewer', async () => {
    const host = await mount(false)
    expect(host.textContent).not.toContain('Add file')
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Edit')).toBe(false)
  })

  it('returns mobile editing to the file list only from the breadcrumb back action', async () => {
    mocks.isMobile = true
    const memory = await mount()
    const tree = memory.querySelector<HTMLElement>('[data-file-browser-pane="tree"]')!
    const preview = memory.querySelector<HTMLElement>('[data-file-browser-pane="preview"]')!
    await clickButton(tree, 'MEMORY.md')
    expect(tree.classList.contains('hidden')).toBe(true)
    expect(preview.classList.contains('flex')).toBe(true)

    await clickButton(memory, 'Edit')
    await clickButton(memory, 'Cancel')
    expect(tree.classList.contains('hidden')).toBe(true)
    expect(preview.classList.contains('flex')).toBe(true)

    await clickButton(memory, 'Edit')
    const back = memory.querySelector<HTMLButtonElement>('button[aria-label="Back to files"]')
    expect(back).not.toBeNull()
    await act(async () => back?.click())
    expect(tree.classList.contains('block')).toBe(true)
    expect(preview.classList.contains('hidden')).toBe(true)
  })
})
