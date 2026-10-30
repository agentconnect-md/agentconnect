// @vitest-environment happy-dom
/** The trigger menu's People group: one row per member, listed first, with the viewer's own identities on top. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({ replace: vi.fn(), search: '' }))

const ME = { userId: 'usr-me', email: 'me@example.test', name: 'Mia' }
const members = [
  { userId: 'usr-me', email: 'me@example.test', name: 'Mia', picture: null, role: 'owner', isCurrentUser: true },
  { userId: 'usr-li', email: 'li@example.test', name: 'li', picture: null, role: 'collaborator', isCurrentUser: false }
]
const trigger = (value: string, platform: string, name?: string) => ({ value, platform, ...(name ? { name } : {}) })

vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(mocks.search)
}))
vi.mock('swr', () => ({
  default: (key: string | null) => ({
    data:
      key === 'logto-account-sign-in-methods'
        ? { identities: [{ target: 'slack', userId: 'U-ME' }], hasSecurityVerificationMethod: false }
        : undefined
  })
}))
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  isAuthConfigured: () => true
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/acme${path}` })
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: ME }) }))
vi.mock('@/components/console/PlaygroundProvider', () => ({ usePlayground: () => ({ pgSessionList: [] }) }))
vi.mock('@/components/console/Shell', () => ({ useMobileFilterSlot: () => ({ register: () => undefined }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [{ id: 'agent-a', name: 'Alpha', runtime: 'claude' }],
    allSessions: [],
    crons: [],
    members,
    sessionFacets: { agentIds: [], agentNames: {}, integrations: [], channels: [], triggers: [] }
  })
}))
vi.mock('@/lib/use-session-list', () => ({
  useSessionList: () => ({
    sessions: [],
    total: 0,
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
      integrations: [],
      channels: [],
      triggers: [
        trigger('agent-a', 'webchat'),
        trigger('li@example.test', 'webchat'),
        trigger('usr-li', 'webchat'),
        trigger('U-OTHER', 'slack', 'Avery'),
        trigger('U-ME', 'slack', 'Mia Slack'),
        trigger('usr-me', 'webchat')
      ]
    }
  })
}))
vi.mock('@/components/marks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/marks')>()),
  AgentIconView: () => <span />,
  PlatformMark: ({ platform }: { platform: string }) => <span data-platform-mark={platform} />
}))

const SessionsView = (await import('./SessionsView')).default

let root: Root | undefined
let host: HTMLDivElement | undefined

async function openTriggerMenu() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(<SessionsView />))
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('.selbtn'))) {
    await act(async () => button.click())
    if (document.querySelector('input[aria-label="Filter triggers"]')) return
    await act(async () => button.click())
  }
  throw new Error('trigger filter never opened')
}

const groupLabels = (header: string) =>
  Array.from(
    Array.from(document.querySelectorAll('.fhdr'))
      .find((node) => node.textContent === header)!
      .parentElement!.querySelectorAll('.fopt .flex-1')
  ).map((label) => label.textContent)

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.search = ''
  mocks.replace.mockClear()
})

describe('SessionsView, People triggers', () => {
  it('lists People first, the viewer on top, and one row per member', async () => {
    await openTriggerMenu()

    const headers = Array.from(document.querySelectorAll('.fhdr')).map((node) => node.textContent)
    expect(headers.slice(0, 2)).toEqual(['People', 'Agents'])
    // A member's email and user id are one person; the viewer's console and Slack identities lead.
    expect(groupLabels('People')).toEqual(['Mia (me)', 'Mia Slack (me)', 'Avery', 'li'])
  })

  it("selects a member's row from a link that names them by their email", async () => {
    mocks.search = 'trigger=li%40example.test'
    await openTriggerMenu()

    const selected = Array.from(document.querySelectorAll('.fopt[aria-selected="true"] .flex-1'))
    expect(selected.map((label) => label.textContent)).toEqual(['li'])
  })
})
