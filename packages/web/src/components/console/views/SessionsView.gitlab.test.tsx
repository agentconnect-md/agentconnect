// @vitest-environment happy-dom
/**
 * A GitLab-triggered session is a CODE-HOST session, not a generic webhook.
 *
 * The CP has always been able to answer `hookKind: 'gitlab'`; the console typed the
 * field as `webhook | github`, so those rows folded into the webhook rendering and
 * fell out of the trigger filter entirely — `sessionTriggerKind` returned a value
 * no `switch` arm collected, so the facet was silently dropped. These tests pin
 * both halves: the row renders under the GitLab mark, and the trigger menu offers
 * a GitLab group that filters to it.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({ replace: vi.fn(), sessions: [] as unknown[], triggers: [] as unknown[] }))

vi.mock('next/link', () => ({
  default: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  )
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/acme${path}` })
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/components/console/PlaygroundProvider', () => ({ usePlayground: () => ({ pgSessionList: [] }) }))
vi.mock('@/components/console/Shell', () => ({ useMobileFilterSlot: () => ({ register: () => undefined }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [],
    allSessions: [],
    crons: [],
    members: [],
    sessionFacets: { agentIds: [], agentNames: {}, integrations: [], channels: [], triggers: [] }
  })
}))
vi.mock('@/lib/use-session-list', () => ({
  useSessionList: () => ({
    sessions: mocks.sessions,
    total: mocks.sessions.length,
    nextCursor: null,
    loadingMore: false,
    loadMore: () => undefined,
    isLoading: false,
    isValidating: false
  }),
  sessionFilterAgentKey: () => ''
}))
vi.mock('@/lib/use-session-facets', () => ({
  useSessionFacets: () => ({
    data: {
      agentIds: [],
      agentNames: {},
      integrations: ['hook'],
      channels: [],
      triggers: mocks.triggers
    }
  })
}))
// Real marks would all render as anonymous <svg> paths; these stubs name which one ran.
vi.mock('@/components/marks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/marks')>()),
  AgentIconView: () => <span />,
  GithubMark: () => <span data-mark="github" />,
  GitlabMark: () => <span data-mark="gitlab" />,
  PlatformMark: ({ platform }: { platform: string }) => <span data-platform-mark={platform} />
}))

const SessionsView = (await import('./SessionsView')).default

const gitlabSession = {
  id: 'sess-1',
  agentId: 'agent-a',
  agentName: 'build-agent',
  title: 'Fix the failing pipeline',
  status: 'done',
  statusLabel: 'done',
  time: '2m',
  lastActivityAt: '2026-08-22T09:00:00.000Z',
  platform: 'hook',
  channel: 'acme/platform',
  hookKind: 'gitlab',
  triggeredBy: 'hook:gl-1',
  user: 'acme/platform',
  runtime: 'claude',
  model: 'default',
  cost: '$0.00',
  tokens: '0'
} as unknown as Session

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<SessionsView />)
  })
}

/** Open the trigger dropdown — the filter row's selects share one class, so find it by its search box. */
async function openTriggerMenu() {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('.selbtn'))) {
    await act(async () => button.click())
    if (document.querySelector('input[aria-label="Filter triggers"]')) return
    await act(async () => button.click())
  }
  throw new Error('trigger filter never opened')
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.sessions = []
  mocks.triggers = []
  mocks.replace.mockClear()
})

describe('SessionsView, GitLab triggers', () => {
  it('renders a gitlab-hook session under the GitLab mark, not the generic webhook one', async () => {
    mocks.sessions = [gitlabSession]
    await render()

    expect(document.querySelector('[data-platform-mark="gitlab"]')).not.toBeNull()
    // Negative control: before the fix this row folded to the raw 'hook' platform.
    expect(document.querySelector('[data-platform-mark="hook"]')).toBeNull()
    expect(document.body.textContent).toContain('acme/platform')
  })

  it('offers a GitLab trigger group and filters to the chosen subscription', async () => {
    mocks.sessions = [gitlabSession]
    mocks.triggers = [
      { value: 'hook:gl-1', integration: 'hook', name: 'acme/platform', hookKind: 'gitlab', githubRepoId: null }
    ]
    await render()
    await openTriggerMenu()

    const headers = Array.from(document.querySelectorAll('.fhdr')).map((node) => node.textContent)
    expect(headers).toContain('GitLab')
    // Negative control: a gitlab facet must not be collected as a plain webhook.
    const webhookGroup = Array.from(document.querySelectorAll('.fhdr')).find((n) => n.textContent === 'Webhooks')
    expect(webhookGroup).toBeUndefined()

    const gitlabGroup = Array.from(document.querySelectorAll('.fhdr')).find(
      (n) => n.textContent === 'GitLab'
    )!.parentElement!
    expect(gitlabGroup.querySelector('[data-mark="gitlab"]')).not.toBeNull()

    const option = Array.from(gitlabGroup.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('acme/platform')
    )!
    await act(async () => option.click())
    expect(mocks.replace).toHaveBeenCalledWith('/acme/sessions?trigger=hook%3Agl-1')
  })
})
