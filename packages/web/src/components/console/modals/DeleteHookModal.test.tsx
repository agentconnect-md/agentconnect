// @vitest-environment happy-dom
/**
 * One confirm can target one row, one repository's whole family set, or the
 * whole host — the rows it carries decide which, and the copy has to say so.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HookDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Declare the parameters: a bare `vi.fn(async () => …)` infers a zero-arg mock.
const deleteHook = vi.hoisted(() => vi.fn(async (_id: string, _agentId?: string | null) => undefined))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ deleteHook }) }))

const DeleteHookModal = (await import('./DeleteHookModal')).default

function hook(partial: Partial<HookDto>): HookDto {
  return {
    id: 'hook-1',
    agentId: 'agent-1',
    kind: 'github',
    name: 'acme/api',
    repoFullName: 'acme/api',
    family: 'pull_request',
    events: ['pull_request:*'],
    commentFamilies: [],
    ...partial
  } as HookDto
}

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(target: HookDto | HookDto[]): Promise<string> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<DeleteHookModal hook={target} onClose={() => {}} />)
  })
  return host.textContent ?? ''
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
  deleteHook.mockClear()
})

describe('DeleteHookModal', () => {
  it('names every family a one-repository set removes', async () => {
    const text = await render([
      hook({ id: 'a', family: 'pull_request', events: ['pull_request:*'] }),
      hook({ id: 'b', family: 'issues', events: ['issues:*'] })
    ])
    expect(text).toContain('Remove repository')
    expect(text).toContain('acme/api · PRs, Issues')
    expect(text).not.toContain('Disconnect')
  })

  it('reads as the host disconnect once it spans repositories', async () => {
    const text = await render([
      hook({ id: 'a', name: 'acme/api', repoFullName: 'acme/api' }),
      hook({ id: 'b', name: 'acme/web', repoFullName: 'acme/web' })
    ])
    expect(text).toContain('Disconnect GitHub')
    expect(text).toContain('acme/api, acme/web')
  })

  it('names the one family a single row removes', async () => {
    const text = await render(
      hook({ kind: 'gitlab', name: 'group/proj', repoFullName: 'group/proj', family: 'issues', events: ['issues:*'] })
    )
    expect(text).toContain('Remove project')
    expect(text).toContain('group/proj · Issues')
  })

  it('deletes every row it names', async () => {
    await render([hook({ id: 'a' }), hook({ id: 'b', family: 'issues', events: ['issues:*'] })])
    const del = [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes('Delete'))!
    await act(async () => del.click())
    expect(deleteHook.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
  })
})
