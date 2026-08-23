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
import { HOOK_KIND_GROUP_LABEL, HOOK_TRIGGER_KINDS } from '@/lib/session-trigger'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  sessions: [] as unknown[],
  triggers: [] as unknown[],
  integrations: ['hook'] as string[]
}))

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
      integrations: mocks.integrations,
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

/** Open one filter dropdown — the row's selects share a class, so find it by its search box. */
async function openFilterMenu(noun: string) {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('.selbtn'))) {
    await act(async () => button.click())
    if (document.querySelector(`input[aria-label="Filter ${noun}"]`)) return
    await act(async () => button.click())
  }
  throw new Error(`${noun} filter never opened`)
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.sessions = []
  mocks.triggers = []
  mocks.integrations = ['hook']
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

  it('offers GitLab as its own integration, separate from generic webhooks', async () => {
    // The server-side facet is a first-class `gitlab` entry now; before that these
    // sessions were counted under `hook` and read as "Webhook" in this menu.
    mocks.sessions = [gitlabSession]
    mocks.integrations = ['gitlab', 'hook']
    await render()
    await openFilterMenu('integrations')

    const options = Array.from(document.querySelectorAll<HTMLButtonElement>('.fmenu button'))
    const gitlab = options.find((option) => option.textContent?.includes('GitLab'))
    expect(gitlab).toBeDefined()
    // Negative control: the entry must be its own, not folded into the webhook one.
    expect(options.filter((option) => option.textContent?.trim() === 'Webhook')).toHaveLength(1)
    expect(gitlab!.querySelector('[data-platform-mark="gitlab"]')).not.toBeNull()

    await act(async () => gitlab!.click())
    expect(mocks.replace).toHaveBeenCalledWith('/acme/sessions?integration=gitlab')
  })

  it('offers a GitLab trigger group and filters to the chosen subscription', async () => {
    mocks.sessions = [gitlabSession]
    mocks.triggers = [
      { value: 'hook:gl-1', integration: 'hook', name: 'acme/platform', hookKind: 'gitlab', githubRepoId: null }
    ]
    await render()
    await openFilterMenu('triggers')

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

/**
 * The trigger menu is built by walking the hook-kind vocabulary, not by listing the
 * hosts that exist today — the bug was a `switch` whose arms were written by hand, so a
 * kind nobody had added an arm for was collected nowhere and vanished from the menu.
 */
describe('SessionsView, trigger groups per hook kind', () => {
  it('offers one group per hook kind, code hosts before generic webhooks', async () => {
    mocks.sessions = [gitlabSession]
    mocks.triggers = HOOK_TRIGGER_KINDS.map((kind) => ({
      value: `hook:${kind}-1`,
      integration: 'hook',
      name: `acme/${kind}`,
      hookKind: kind,
      githubRepoId: null
    }))
    await render()
    await openFilterMenu('triggers')

    const headers = Array.from(document.querySelectorAll('.fhdr')).map((node) => node.textContent)
    // Every kind earns its own heading, in the vocabulary's display order.
    expect(headers).toEqual(HOOK_TRIGGER_KINDS.map((kind) => HOOK_KIND_GROUP_LABEL[kind]))
    // Each group holds exactly its own subscription — nothing pooled into one bucket.
    for (const kind of HOOK_TRIGGER_KINDS) {
      const group = Array.from(document.querySelectorAll('.fhdr')).find(
        (node) => node.textContent === HOOK_KIND_GROUP_LABEL[kind]
      )!.parentElement!
      const labels = Array.from(group.querySelectorAll('button')).map((button) => button.textContent)
      expect(labels).toEqual([`acme/${kind}`])
    }
  })
})
