// @vitest-environment happy-dom
// Each picker group fits one row: a longer one shows a More tile in the row's last place and expands on its own.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformTile } from './platforms/host-projections'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const tiles = vi.hoisted(() => ({ list: [] as PlatformTile[] }))

vi.mock('./platforms/host-projections', () => ({
  get PLATFORMS() {
    return tiles.list
  }
}))
vi.mock('./platforms/offered', () => ({ useOfferedPlatform: () => () => true }))

const { IntegrationPlatformGroups } = await import('./IntegrationPlatformGroups')

// Registered chat platforms land in Chat; ids no module claims land in Workflow, as the core trigger kinds do.
const CHAT = ['slack', 'msteams', 'googlechat', 'discord', 'telegram', 'feishu', 'dingtalk', 'wecom', 'wechat', 'qq']
const chat = (count: number) => CHAT.slice(0, count).map((key) => ({ key, label: key }))
const workflow = (count: number) => Array.from({ length: count }, (_, i) => ({ key: `w${i + 1}`, label: `w${i + 1}` }))

let host: HTMLDivElement
let root: Root

async function render(list: PlatformTile[], selectedPlatform?: string): Promise<void> {
  tiles.list = list
  await act(async () =>
    root.render(
      <IntegrationPlatformGroups
        selectedPlatform={selectedPlatform}
        renderTile={(tile) => (
          <div key={tile.key} className="tile">
            {tile.key}
          </div>
        )}
      />
    )
  )
}

const group = (label: string) => host.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!
const shown = (label: string) => [...group(label).querySelectorAll('.tile')].map((tile) => tile.textContent)
const more = (label: string) => group(label).querySelector<HTMLButtonElement>('button')

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('IntegrationPlatformGroups', () => {
  it('shows no More for groups that fit one row', async () => {
    await render([...chat(7), ...workflow(7)])
    expect(more('Chat')).toBeNull()
    expect(more('Workflow')).toBeNull()
    expect(shown('Workflow')).toHaveLength(7)
  })

  it('collapses the Workflow group to one row ending in More', async () => {
    await render([...chat(5), ...workflow(8)])
    expect(more('Chat')).toBeNull()
    expect(shown('Workflow')).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6'])
    expect(more('Workflow')?.textContent).toBe('More')
    await act(async () => more('Workflow')!.click())
    expect(shown('Workflow')).toHaveLength(8)
    expect(more('Workflow')).toBeNull()
  })

  it('expands each group on its own', async () => {
    await render([...chat(9), ...workflow(8)])
    expect(shown('Chat')).toHaveLength(6)
    expect(shown('Workflow')).toHaveLength(6)
    await act(async () => more('Chat')!.click())
    expect(shown('Chat')).toHaveLength(9)
    expect(shown('Workflow')).toHaveLength(6)
    expect(more('Workflow')).not.toBeNull()
  })

  it('expands the group whose hidden part holds the selected platform', async () => {
    await render([...chat(9), ...workflow(8)], 'w8')
    expect(shown('Workflow')).toContain('w8')
    expect(more('Workflow')).toBeNull()
    expect(more('Chat')).not.toBeNull()
  })
})
