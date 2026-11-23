// @vitest-environment happy-dom
// The page a chat app's out-of-credits notice links: the card for one agent, its reason read from ?code.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  search: 'code=never_funded',
  agent: undefined as unknown,
  agentsLoading: false,
  daemons: [] as unknown[]
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'agent-1' }),
  usePathname: () => '/acme/agents/agent-1/out-of-credits',
  useSearchParams: () => new URLSearchParams(mocks.search)
}))
vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children?: ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  )
}))
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: () => true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (path: string) => `/acme${path}` })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    getAgent: () => mocks.agent,
    agentsLoading: mocks.agentsLoading,
    orgSetIds: new Set<string>()
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchDaemons: vi.fn(async () => mocks.daemons)
}))
vi.mock('@/components/console/ModalProvider', () => ({ useOptionalModal: () => ({ openModal: vi.fn() }) }))

const { default: OutOfCreditsView } = await import('./OutOfCreditsView')

const AGENT = { id: 'agent-1', name: 'pilot', placementKind: 'set', setId: null, canEdit: true } as unknown as Agent

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <OutOfCreditsView />
      </SWRConfig>
    )
  )
  await act(async () => undefined)
}

const moveButton = () => [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Move to your own machine')

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  mocks.search = 'code=never_funded'
  mocks.agent = undefined
  mocks.daemons = []
})

describe('OutOfCreditsView', () => {
  it('shows the card for the linked reason with both fixes', async () => {
    mocks.agent = AGENT
    mocks.daemons = [{ daemonId: 'd1', pool: false }]
    await render()
    expect(host!.textContent).toContain("hasn't added any credits yet")
    expect(host!.querySelector('a.dsbtn')?.getAttribute('href')).toContain('/acme/billing')
    expect(moveButton()?.disabled).toBe(false)
  })

  it('greys out the move when the org has no machine of its own', async () => {
    mocks.agent = AGENT
    mocks.search = 'code=out_of_credits'
    await render()
    expect(host!.textContent).toContain('run out of credits')
    expect(moveButton()?.disabled).toBe(true)
  })

  it('says so when the agent is gone', async () => {
    await render()
    expect(host!.textContent).toContain("This agent no longer exists, or you can't see it.")
  })
})
