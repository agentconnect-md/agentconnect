// @vitest-environment happy-dom
/** An agent switches GitHub Apps only once the picked App reaches everything it works on. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type GithubAppCoverageItem } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  coverage: [] as GithubAppCoverageItem[],
  switchAgentGithubApp: vi.fn(async () => undefined),
  selectGithubAppOwners: vi.fn(async () => ({
    personal: 'example-user',
    organizations: ['example-org', 'another-org']
  })),
  startGithubAppManifest: vi.fn(async () => ({
    action: 'https://github.com/settings/apps/new?state=example-state',
    manifest: { name: 'example-app', public: true }
  })),
  refresh: vi.fn()
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org-1' } }) }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ refresh: mocks.refresh }) }))
vi.mock('@/lib/github-app-owners', () => ({ selectGithubAppOwners: mocks.selectGithubAppOwners }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchBuiltinGithubApp: vi.fn(async () => ({ slug: 'example-connect', appId: 1000 })),
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
  switchAgentGithubApp: mocks.switchAgentGithubApp,
  startGithubAppManifest: mocks.startGithubAppManifest
}))

const { GithubAppDialog } = await import('./GithubAppDialog')

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(agentId: string, onClose = vi.fn(), onSwitched = vi.fn(), initialAppId = 'app-free') {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <GithubAppDialog
        agent={{ id: agentId, githubAppId: null }}
        initialAppId={initialAppId}
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
  mocks.startGithubAppManifest.mockClear()
  mocks.selectGithubAppOwners.mockClear()
  vi.restoreAllMocks()
  document.querySelectorAll('form').forEach((form) => form.remove())
})

describe('GithubAppDialog', () => {
  it('creates for the signed-in personal account and posts the returned manifest to GitHub', async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    await render('agent-personal', vi.fn(), vi.fn(), 'create')
    expect(document.body.textContent).toContain('My personal GitHub account')
    expect(document.body.textContent).toContain('Created as a public App')
    await act(async () => button('Continue on GitHub')?.click())
    expect(mocks.startGithubAppManifest).toHaveBeenCalledWith('agent-personal', null)
    expect(submit).toHaveBeenCalledOnce()
    const form = document.querySelector('form')!
    expect(form.action).toBe('https://github.com/settings/apps/new?state=example-state')
    expect(form.method).toBe('post')
    expect(JSON.parse((form.elements.namedItem('manifest') as HTMLInputElement).value)).toEqual({
      name: 'example-app',
      public: true
    })
  })

  it('loads the user’s organizations and sends the picked owner without free-text input', async () => {
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    await render('agent-organization', vi.fn(), vi.fn(), 'create')
    await act(async () => button('Choose from my GitHub organizations')?.click())
    expect(mocks.selectGithubAppOwners).toHaveBeenCalledWith('agent-organization', 'org-1', expect.any(AbortSignal))
    await act(async () => (document.querySelector('button[aria-label="App owner"]') as HTMLButtonElement).click())
    expect(document.body.textContent).toContain('another-org')
    await act(async () => button('example-orgGitHub organization')?.click())
    expect(document.querySelector('input[placeholder="example-org"]')).toBeNull()
    await act(async () => button('Continue on GitHub')?.click())
    expect(mocks.startGithubAppManifest).toHaveBeenCalledWith('agent-organization', 'example-org')
  })

  it('shows an authorization failure and lets the user retry', async () => {
    mocks.selectGithubAppOwners.mockRejectedValueOnce(new Error('cancelled'))
    await render('agent-retry', vi.fn(), vi.fn(), 'create')
    await act(async () => button('Choose from my GitHub organizations')?.click())
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not complete GitHub authorization')
    await act(async () => button('Choose from my GitHub organizations')?.click())
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain('example-user')
  })

  it.each([
    [new Error('popup-blocked'), 'Allow popups for this site'],
    [new ApiError('GitHub authorization is not configured', 503), 'GitHub authorization is not configured']
  ])('shows the actionable cause of an account lookup failure', async (error, message) => {
    mocks.selectGithubAppOwners.mockRejectedValueOnce(error)
    await render('agent-failure', vi.fn(), vi.fn(), 'create')
    await act(async () => button('Choose from my GitHub organizations')?.click())
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(message)
  })

  it('keeps validated manual entry available when an organization cannot be loaded', async () => {
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    await render('agent-manual', vi.fn(), vi.fn(), 'create')
    await act(async () => (document.querySelector('button[aria-label="App owner"]') as HTMLButtonElement).click())
    await act(async () => button('Enter an organization manually…')?.click())
    expect(button('Continue on GitHub')?.disabled).toBe(true)
    const input = document.querySelector('input[placeholder="example-org"]') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    for (const [value, disabled] of [
      ['../other', true],
      [' example-org ', false]
    ] as const) {
      await act(async () => {
        setValue.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(button('Continue on GitHub')?.disabled).toBe(disabled)
    }
    await act(async () => button('Continue on GitHub')?.click())
    expect(mocks.startGithubAppManifest).toHaveBeenCalledWith('agent-manual', 'example-org')
  })

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
