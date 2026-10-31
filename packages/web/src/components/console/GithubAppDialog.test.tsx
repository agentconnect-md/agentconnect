// @vitest-environment happy-dom
/** An agent switches GitHub Apps only once the picked App reaches everything it works on. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GithubAppCoverageItem } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  coverage: [] as GithubAppCoverageItem[],
  switchAgentGithubApp: vi.fn(async () => undefined),
  refresh: vi.fn()
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org-1' } }) }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ refresh: mocks.refresh }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchBuiltinGithubAppSlug: vi.fn(async () => 'example-connect'),
  fetchGithubApps: vi.fn(async () => [
    {
      id: 'app-free',
      appId: 2001,
      slug: 'review-example',
      botUserId: 9001,
      agentId: null,
      installations: [],
      createdAt: '2026-10-20T00:00:00.000Z'
    },
    {
      id: 'app-taken',
      appId: 2002,
      slug: 'triage-example',
      botUserId: 9002,
      agentId: 'agent-other',
      installations: [],
      createdAt: '2026-10-21T00:00:00.000Z'
    }
  ]),
  fetchGithubAppCoverage: vi.fn(async () => mocks.coverage),
  switchAgentGithubApp: mocks.switchAgentGithubApp
}))

const { GithubAppDialog } = await import('./GithubAppDialog')

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(agentId: string, onClose = vi.fn(), onSwitched = vi.fn()) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <GithubAppDialog
        agent={{ id: agentId, githubAppId: null }}
        initialAppId="app-free"
        onClose={onClose}
        onSwitched={onSwitched}
      />
    )
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  return onClose
}

const button = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as
    HTMLButtonElement | undefined

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.switchAgentGithubApp.mockClear()
  mocks.refresh.mockClear()
})

describe('GithubAppDialog', () => {
  it('lists what the picked App misses, links to install it, and holds the switch', async () => {
    mocks.coverage = [
      { target: 'example-org/api', kind: 'review', covered: true },
      { target: 'example-org/web', kind: 'repository', covered: false }
    ]
    await render('agent-a')

    expect(document.body.textContent).toContain('example-org/web')
    const install = document.querySelector('a[href="https://github.com/apps/review-example/installations/new"]')
    expect(install?.textContent).toBe('Add on GitHub')
    expect(button('Switch')?.disabled).toBe(true)
    expect(button('Check again')).toBeDefined()
    // An App another agent works through is never offered.
    expect(document.body.textContent).not.toContain('triage-example')
  })

  it('switches once everything is covered, tells the opener, then refreshes and closes', async () => {
    mocks.coverage = [{ target: 'example-org/api', kind: 'review', covered: true }]
    const onSwitched = vi.fn()
    const onClose = await render('agent-b', vi.fn(), onSwitched)

    expect(button('Switch')?.disabled).toBe(false)
    await act(async () => button('Switch')?.click())

    expect(mocks.switchAgentGithubApp).toHaveBeenCalledWith('agent-b', 'app-free')
    expect(mocks.refresh).toHaveBeenCalled()
    // An open picker reloads with the new App's installations.
    expect(onSwitched).toHaveBeenCalledWith('app-free')
    expect(onClose).toHaveBeenCalled()
  })
})
