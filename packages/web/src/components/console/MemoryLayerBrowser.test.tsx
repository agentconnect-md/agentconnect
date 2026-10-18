// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryEntryCapabilities } from '@agentconnect.md/protocol'

const mocks = vi.hoisted(() => ({ isMobile: false }))

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
    describeAgentMemoryEntries: vi.fn(),
    listAgentMemoryEntries: vi.fn(),
    getAgentMemoryEntry: vi.fn(),
    createAgentMemoryEntry: vi.fn(),
    updateAgentMemoryEntry: vi.fn(),
    deleteAgentMemoryEntry: vi.fn(),
    listAgentMemoryEntryHistory: vi.fn(),
    fetchAgentMemoryChannels: vi.fn(),
    clearAgentMemoryChannel: vi.fn(),
    fetchAgentMemoryFull: vi.fn(),
    listMyAgentMemory: vi.fn(),
    fetchMyAgentMemoryFull: vi.fn(),
    wakeAgent: vi.fn(async () => ({ state: 'starting' })),
    fetchWorkspaceFiles: vi.fn(),
    fetchWorkspaceGitStatus: vi.fn()
  }
})
// The lazy Markdown view renders as a marked stub; its own behavior is covered by MarkdownView tests.
vi.mock('next/dynamic', () => ({
  default: () => (props: { content: string }) => <div data-testid="markdown">{props.content}</div>
}))
vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => mocks.isMobile }))

import * as api from '@/lib/api'
import type { MemoryChannelDto } from '@/lib/api'
import { NextIntlClientProvider } from 'next-intl'
import chinese from '../../../messages/zh-CN.json'
import { MemoryLayerBrowser } from './MemoryLayerBrowser'

const AGENT = '22222222-2222-4222-8222-222222222222'
const caps: MemoryEntryCapabilities = {
  version: 1,
  operations: ['list', 'get', 'create', 'update', 'delete'],
  supportedScopes: ['agent', 'channel'],
  writeConsistency: 'conditional',
  exactCreate: true,
  exactEdit: true,
  enumeration: 'live',
  graph: false,
  limits: { maxItemBytes: 256000, maxPageItems: 100, maxMutationRequestBytes: 196608 }
}
const topic = (ref: string, label: string, description?: string) => ({
  ref,
  label,
  description,
  revision: 'r1',
  byteSize: 8,
  format: 'markdown' as const,
  origin: 'active' as const,
  editable: true,
  updatedAt: '2026-10-14T09:00:00.000Z'
})
const HIDDEN: MemoryChannelDto = {
  channelKey: 'slack-C0EXAMPLE6-6a6b6c',
  channel: 'C0EXAMPLE6',
  transportScope: null,
  platform: 'slack',
  name: 'secret-room',
  visible: false,
  clearable: true
}
const LAYERS: MemoryChannelDto[] = [
  HIDDEN,
  {
    channelKey: 'slack-C0EXAMPLE1-1a1b1c',
    channel: 'C0EXAMPLE1',
    transportScope: null,
    platform: 'slack',
    name: 'launch-room',
    visible: true
  },
  { channelKey: 'slack-D0EXAMPLE-2a2b', channel: 'D0EXAMPLE', transportScope: null, platform: 'slack', name: '@alex' },
  // What an older Control Plane or daemon answers: the channel id alone, or not even that.
  { channelKey: 'scope-0example--C0EXAMPLE5-5a5b', channel: null, transportScope: null }
]
const LAUNCH = 'slack-C0EXAMPLE1-1a1b1c'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.isMobile = false
  vi.mocked(api.describeAgentMemoryEntries).mockResolvedValue(caps)
  vi.mocked(api.listAgentMemoryEntries).mockImplementation(async (_agent, channelKey) => ({
    entries:
      channelKey === LAUNCH
        ? [
            topic('launch-ref', 'q1-priorities', 'Enterprise tier first'),
            { ...topic('shared-ref', 'hiring-plan'), origin: 'inherited' as const, editable: false }
          ]
        : [topic('shared-ref', 'hiring-plan', 'Two backend engineers')],
    consistency: 'live',
    order: 'topic'
  }))
  vi.mocked(api.getAgentMemoryEntry).mockImplementation(async (_agent, ref) => ({
    entry:
      ref === 'launch-ref'
        ? topic(ref, 'q1-priorities', 'Enterprise tier first')
        : topic(ref, 'hiring-plan', 'Two backend engineers'),
    text: `body of ${ref}`,
    complete: true
  }))
  vi.mocked(api.updateAgentMemoryEntry).mockResolvedValue({ operationId: 'op', state: 'completed' })
  vi.mocked(api.createAgentMemoryEntry).mockResolvedValue({ operationId: 'op', state: 'completed' })
  vi.mocked(api.fetchAgentMemoryChannels).mockResolvedValue({ channels: LAYERS })
  vi.mocked(api.clearAgentMemoryChannel).mockResolvedValue({ cleared: true })
  vi.mocked(api.fetchAgentMemoryFull).mockResolvedValue({
    exists: true,
    content: '# Index',
    mtime: '2026-10-14T09:00:00.000Z'
  })
  vi.mocked(api.listMyAgentMemory).mockResolvedValue({
    exists: true,
    files: [{ name: 'preferences.md', size: 12, mtime: '2026-10-16T09:00:00.000Z' }]
  })
  vi.mocked(api.fetchMyAgentMemoryFull).mockResolvedValue({ exists: true, content: 'short bullets', mtime: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => Promise.resolve())
}
async function render(
  props: Partial<Parameters<typeof MemoryLayerBrowser>[0]> = {},
  wrap?: (n: ReactNode) => ReactNode
) {
  const node = <MemoryLayerBrowser agentId={AGENT} canEdit header={(newMemory) => newMemory} {...props} />
  await act(async () => root.render(wrap ? wrap(node) : node))
  await settle()
}
const tree = () => host.querySelector<HTMLElement>('[data-memory-pane="tree"]')!
const reader = () => host.querySelector<HTMLElement>('[data-memory-pane="reader"]')!
const rowNames = () =>
  [...tree().querySelectorAll('button[style]')].map((button) => button.querySelector('span.flex-1')?.textContent)
// A tree row's name sits beside its date, so a row matches on its name alone.
const button = (scope: HTMLElement, text: string) =>
  [...scope.querySelectorAll('button')].find(
    (candidate) => (candidate.querySelector('span.flex-1') ?? candidate).textContent?.trim() === text
  )
async function click(scope: HTMLElement, text: string) {
  const target = button(scope, text)
  expect(target, `${text} button`).toBeTruthy()
  await act(async () => target!.click())
  await settle()
}

describe('MemoryLayerBrowser tree', () => {
  it('lists Shared open, each readable place by name, an unreadable one, then Personal — with no file counts', async () => {
    await render()
    expect(rowNames()).toEqual([
      'Shared',
      'MEMORY.md',
      'hiring-plan',
      '#launch-room',
      '@alex',
      'scope-0example--C0EXAMPLE5-5a5b',
      '#secret-room',
      'Personal'
    ])
    // The platform rides in the tooltip, and nothing on a layer row counts its files.
    const launch = [...tree().querySelectorAll('button')].find((row) => row.textContent?.includes('#launch-room'))
    expect(launch?.getAttribute('title')).toBe('#launch-room · Slack')
    expect(launch?.getAttribute('aria-expanded')).toBe('false')
    expect(tree().textContent).not.toMatch(/Shared\d/)
    // Shared, three readable places and Personal.
    expect(tree().textContent).toContain('5 layers you can see')
    expect(api.listAgentMemoryEntries).toHaveBeenCalledTimes(1)
  })

  it('opens the shared index first, then reads a place layer only once it is expanded', async () => {
    await render()
    expect(api.fetchAgentMemoryFull).toHaveBeenCalledWith(AGENT, undefined, undefined)
    expect(reader().textContent).toContain('MEMORY.md')
    expect(reader().textContent).toContain('Shared')
    expect(reader().querySelector('[data-testid="markdown"]')?.textContent).toBe('# Index')

    await click(tree(), '#launch-room')
    expect(api.listAgentMemoryEntries).toHaveBeenCalledWith(AGENT, LAUNCH)
    // The place lists only its own files; the inherited shared one stays under Shared.
    expect(rowNames().filter((name) => name === 'hiring-plan')).toHaveLength(1)
    await click(tree(), 'q1-priorities')
    expect(api.getAgentMemoryEntry).toHaveBeenCalledWith(AGENT, 'launch-ref', LAUNCH, undefined)
    expect(reader().textContent).toContain('#launch-room')
    expect(reader().textContent).toContain('updated')
    expect(reader().textContent).toContain('Enterprise tier first')
    expect(reader().querySelector('[data-testid="markdown"]')?.textContent).toBe('body of launch-ref')
  })

  it('edits a place file in place and saves it to that layer', async () => {
    await render()
    await click(tree(), '#launch-room')
    await click(tree(), 'q1-priorities')
    expect(button(reader(), 'History')).toBeUndefined()
    expect(button(reader(), 'Delete')).toBeTruthy()
    await click(reader(), 'Edit')
    expect(reader().querySelector('textarea')?.value).toBe('body of launch-ref')
    await click(reader(), 'Save memory')
    expect(api.updateAgentMemoryEntry).toHaveBeenCalledWith(
      AGENT,
      { ref: 'launch-ref', revision: 'r1', text: 'body of launch-ref' },
      LAUNCH
    )
    expect(reader().textContent).toContain('Memory saved.')
  })

  it('creates a memory in the layer being read', async () => {
    await render()
    await click(tree(), '#launch-room')
    await click(tree(), 'q1-priorities')
    await click(host, 'New memory')
    expect(reader().textContent).toContain('#launch-room')
    const name = reader().querySelector<HTMLInputElement>('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'oncall')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(reader(), 'Save memory')
    expect(api.createAgentMemoryEntry).toHaveBeenCalledWith(AGENT, { text: '', label: 'oncall' }, LAUNCH)
  })

  it('offers no writes to a viewer', async () => {
    await render({ canEdit: false })
    expect(button(host, 'New memory')).toBeUndefined()
    await click(tree(), 'hiring-plan')
    expect(button(reader(), 'Edit')).toBeUndefined()
    expect(button(reader(), 'Delete')).toBeUndefined()
  })

  it("reads the caller's own memory read-only from the Personal layer", async () => {
    await render()
    await click(tree(), 'Personal')
    expect(api.listMyAgentMemory).toHaveBeenCalledWith(AGENT)
    await click(tree(), 'preferences.md')
    expect(api.fetchMyAgentMemoryFull).toHaveBeenCalledWith(AGENT, 'preferences.md')
    expect(reader().textContent).toContain('Personal')
    expect(reader().querySelector('[data-testid="markdown"]')?.textContent).toBe('short bullets')
    expect(button(reader(), 'Edit')).toBeUndefined()
  })

  it('says when the agent keeps nothing for you', async () => {
    vi.mocked(api.listMyAgentMemory).mockResolvedValue({ exists: false, files: [] })
    await render()
    await click(tree(), 'Personal')
    expect(tree().textContent).toContain('The agent keeps nothing for you yet.')
  })

  it('filters every layer by name and description, and says when nothing matches', async () => {
    await render()
    const input = tree().querySelector<HTMLInputElement>('input')!
    const type = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await settle()
    }
    await type('enterprise')
    expect(api.listAgentMemoryEntries).toHaveBeenCalledWith(AGENT, LAUNCH)
    expect(rowNames()).toEqual(['#launch-room', 'q1-priorities'])
    await type('nothing-like-this')
    expect(tree().textContent).toContain('No files match.')
  })

  it('follows every page while filtering, so a file past the first page is found', async () => {
    vi.mocked(api.listAgentMemoryEntries).mockImplementation(async (_agent, channelKey, cursor) =>
      channelKey
        ? { entries: [], consistency: 'live', order: 'topic' }
        : cursor
          ? { entries: [topic('late-ref', 'oncall-rota')], consistency: 'live', order: 'topic' }
          : {
              entries: [topic('shared-ref', 'hiring-plan')],
              nextCursor: 'page-2',
              consistency: 'live',
              order: 'topic'
            }
    )
    await render()
    // Unfiltered, the second page waits behind Load more.
    expect(button(tree(), 'Load more')).toBeTruthy()
    expect(rowNames()).not.toContain('oncall-rota')
    const input = tree().querySelector<HTMLInputElement>('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'oncall')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle()
    expect(api.listAgentMemoryEntries).toHaveBeenCalledWith(AGENT, undefined, 'page-2')
    expect(rowNames()).toEqual(['Shared', 'oncall-rota'])
    expect(tree().textContent).not.toContain('No files match.')
  })
})

describe('MemoryLayerBrowser unreadable layers', () => {
  const panel = () => host.querySelector<HTMLElement>('[data-memory-hidden-layer]')
  const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')

  it('names an unreadable layer without reading it, and clears it only after the confirmation', async () => {
    await render()
    await click(tree(), '#secret-room')
    expect(panel()?.textContent).toContain('You can’t see any of this conversation’s sessions')
    expect(api.listAgentMemoryEntries).not.toHaveBeenCalledWith(AGENT, HIDDEN.channelKey)
    await click(panel()!, 'Clear this layer')
    expect(api.clearAgentMemoryChannel).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('Every file the agent keeps for #secret-room · Slack is deleted')
    await click(dialog()!, 'Clear this layer')
    expect(api.clearAgentMemoryChannel).toHaveBeenCalledWith(AGENT, HIDDEN.channelKey)
    expect(dialog()).toBeNull()
    expect(rowNames()).not.toContain('#secret-room')
  })

  it('keeps the confirmation open with the reason when the clear fails', async () => {
    vi.mocked(api.clearAgentMemoryChannel).mockRejectedValueOnce(new api.ApiError('owning daemon is offline', 503))
    await render()
    await click(tree(), '#secret-room')
    await click(panel()!, 'Clear this layer')
    await click(dialog()!, 'Clear this layer')
    expect(dialog()?.textContent).toContain('owning daemon is offline')
    expect(rowNames()).toContain('#secret-room')
  })

  it('offers no clear when the caller may not clear the layer', async () => {
    vi.mocked(api.fetchAgentMemoryChannels).mockResolvedValue({ channels: [{ ...HIDDEN, clearable: false }] })
    await render()
    await click(tree(), '#secret-room')
    expect(panel()).not.toBeNull()
    expect(panel()?.querySelector('button')).toBeNull()
  })

  it('reads in Chinese with the zh-CN messages', async () => {
    await render({}, (node) => (
      <NextIntlClientProvider locale="zh-CN" messages={chinese} timeZone="UTC">
        {node}
      </NextIntlClientProvider>
    ))
    expect(rowNames()[0]).toBe('共享')
    expect(rowNames().at(-1)).toBe('个人')
    expect(tree().textContent).toContain('你能看到 5 层')
    await click(tree(), '#secret-room')
    expect(panel()?.textContent).toContain('这个对话的会话你都看不到')
    expect(panel()?.textContent).toContain('清空这一层')
  })
})

describe('MemoryLayerBrowser on mobile', () => {
  it('shows the tree, then the reader with a way back, one at a time', async () => {
    mocks.isMobile = true
    await render()
    // The shared index is selected for the desktop reader, but the phone stays on the tree.
    expect(tree().className).not.toContain('hidden')
    expect(reader().className).toContain('hidden')
    await click(tree(), 'hiring-plan')
    expect(tree().className).toContain('hidden')
    expect(reader().className).toContain('flex')
    await act(async () => reader().querySelector<HTMLButtonElement>('[aria-label="Back to files"]')?.click())
    expect(tree().className).not.toContain('hidden desktop')
  })

  it('keeps an open draft on screen: Back waits until the edit is saved or cancelled', async () => {
    mocks.isMobile = true
    await render()
    await click(tree(), 'hiring-plan')
    const back = () => reader().querySelector<HTMLButtonElement>('[aria-label="Back to files"]')!
    expect(back().disabled).toBe(false)
    await click(reader(), 'Edit')
    expect(back().disabled).toBe(true)
    await click(reader(), 'Cancel')
    expect(back().disabled).toBe(false)
    await click(host, 'New memory')
    expect(back().disabled).toBe(true)
  })
})
