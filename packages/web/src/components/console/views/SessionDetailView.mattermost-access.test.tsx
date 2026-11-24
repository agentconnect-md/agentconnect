// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  search: 'source=mattermost',
  fetchMySessionIdentity: vi.fn(async (_provider: string) => ({ linked: false }))
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'session-mm-1' }),
  usePathname: () => '/acme/sessions/session-mm-1',
  useSearchParams: () => new URLSearchParams(state.search),
  useRouter: () => ({
    replace: () => {},
    push: () => {},
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {}
  })
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchSessionMessages: vi.fn(() => Promise.resolve({ messages: [], nextCursor: null })),
    fetchSessionDetail: vi.fn(() => Promise.reject(new actual.ApiError('Session not found', 404))),
    fetchMySessionIdentity: (provider: string) => state.fetchMySessionIdentity(provider),
    fetchConversationByKey: vi.fn(() => Promise.reject(new actual.ApiError('Conversation not found', 404))),
    fetchAgentTasks: vi.fn(() => Promise.reject(new Error('no tasks'))),
    fetchSessionPullRequest: vi.fn(() => Promise.reject(new actual.ApiError('pull request not found', 404))),
    fetchWorkspaceFiles: vi.fn(() => Promise.resolve({ path: '.', exists: true, entries: [], nextCursor: null })),
    fetchWorkspaceGitStatus: vi.fn(() => Promise.resolve({ isRepo: false })),
    fetchWorkspaceGitLog: vi.fn(() => Promise.resolve({ isRepo: false, commits: [], truncated: false, tracking: null }))
  }
})

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [],
    allSessions: [],
    getSessions: () => [],
    sessionsLoading: false,
    crons: [],
    integrations: [],
    bots: [],
    daemons: [],
    members: [],
    sessionActivityVersionById: {},
    sessionStreamGeneration: 0,
    revalidateSessionLists: () => {}
  })
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({
    activeOrg: { id: 'org-1', slug: 'acme' },
    myRole: 'collaborator',
    orgPath: (p: string) => `/acme${p}`
  })
}))

vi.mock('@/lib/profile', () => ({ useProfile: () => ({ user: { name: 'Sam' }, me: null }) }))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))
vi.mock('@/lib/stick-to-bottom', () => ({ useStickToBottom: () => ({ pin: () => {}, awayFromBottom: false }) }))
vi.mock('@/lib/auth', () => ({ isAuthConfigured: () => true }))
vi.mock('@/lib/use-session-list', () => ({
  useSessionList: () => ({ sessions: [], total: 0, isLoading: false, nextCursor: null, loadingMore: false })
}))
vi.mock('@/components/console/Shell', () => ({
  useCrumbSlot: () => ({ register: () => {} }),
  useMobileActionSlot: () => ({ action: null, register: () => {} })
}))
vi.mock('@/components/console/PlaygroundProvider', () => {
  const playground = {
    getPgSuggestion: () => undefined,
    getPgSession: () => undefined,
    getLiveSteps: () => [],
    getBusyLaneAgentIds: () => [],
    reconcileLiveSteps: () => {},
    getPgImage: () => null,
    getPgFiles: () => [],
    setPgFiles: () => {},
    getPgWorktree: () => false,
    isPgBusy: () => false,
    isPgTurnUnstreamed: () => false,
    setPgImage: () => {},
    openPlayground: () => 'pg_new',
    pgSend: () => true,
    pgAttach: () => {},
    getPgQueue: () => [],
    pgCancelQueued: () => {},
    pgAddAgent: () => {},
    pgSetModel: () => {},
    pgSetEffort: () => {},
    pgSetPermissionPreset: () => {},
    pgSetFast: () => {},
    pgSetWorktree: () => {},
    pgCancel: () => {},
    pgAnswerElicitation: () => {},
    setPgInput: () => {}
  }
  return { usePlayground: () => playground, usePgDraft: () => '', usePgDraftHasText: () => false }
})

import SessionDetailView, { profileProviderHint } from './SessionDetailView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

async function renderView() {
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SessionDetailView />
      </SWRConfig>
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  state.search = 'source=mattermost'
  state.fetchMySessionIdentity.mockReset()
  state.fetchMySessionIdentity.mockResolvedValue({ linked: false })
  delete window.__AC_ENV
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  container = undefined
  root = undefined
  delete window.__AC_ENV
})

describe('Mattermost profile hint on unavailable session details', () => {
  it('maps mattermost directly to the mattermost sign-in target without falling back to gitlab', async () => {
    window.__AC_ENV = { SOCIAL_PROVIDERS: 'gitlab' }
    expect(profileProviderHint('mattermost')).toBe('mattermost')
    await renderView()
    expect(state.fetchMySessionIdentity).not.toHaveBeenCalled()
    expect(container?.textContent).not.toContain('Link GitLab profile')
    expect(container?.textContent).not.toContain('Link Mattermost profile')

    window.__AC_ENV = { SOCIAL_PROVIDERS: 'gitlab,mattermost' }
    expect(profileProviderHint('mattermost')).toBe('mattermost')
    await renderView()
    expect(state.fetchMySessionIdentity).toHaveBeenCalledWith('mattermost')
    expect(container?.textContent).toContain('Link Mattermost profile')
    expect(container?.textContent).toContain('Mattermost profile isn’t linked')
  })

  it('uses the integration query parameter when source is absent', async () => {
    state.search = 'integration=mattermost'
    window.__AC_ENV = { SOCIAL_PROVIDERS: 'mattermost' }
    await renderView()
    expect(state.fetchMySessionIdentity).toHaveBeenCalledWith('mattermost')
    expect(container?.textContent).toContain('Link Mattermost profile')
  })
})
