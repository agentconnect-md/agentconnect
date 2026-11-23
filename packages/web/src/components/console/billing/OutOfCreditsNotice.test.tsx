// @vitest-environment happy-dom
// A Cloud turn that failed for lack of credit draws the out-of-credits card in place of its text, on all three paths a failure reaches the transcript by.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'
import type { FmtStep } from '@/components/console/transcript-steps'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  role: 'owner',
  flags: new Set(['billing', 'managed']),
  daemons: [] as unknown[] | Error,
  openModal: vi.fn()
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/acme/sessions/s1',
  useSearchParams: () => new URLSearchParams('thread=t1')
}))
vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children?: ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  )
}))
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: (id: string) => mocks.flags.has(id) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: mocks.role, orgPath: (path: string) => `/acme${path}` })
}))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ orgSetIds: new Set<string>() }) }))
// The card asks for the fleet itself, so the API read is what each case varies.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchDaemons: vi.fn(async () => {
    if (mocks.daemons instanceof Error) throw mocks.daemons
    return mocks.daemons
  })
}))
vi.mock('@/components/console/ModalProvider', () => ({
  useOptionalModal: () => ({ openModal: mocks.openModal })
}))

const { BotTurnView } = await import('@/components/console/TurnViews')
const { plainStep } = await import('@/components/console/transcript-steps')
const { NOTICE_LANE } = await import('@/components/console/session-work')

const TAG = '[ERR:out_of_credits] Out of AgentConnect credits'
const CLOUD_AGENT = {
  id: 'agent-1',
  name: 'pilot',
  placementKind: 'set',
  setId: null,
  canEdit: true
} as unknown as Agent
const MACHINE = { daemonId: 'd1', pool: false, status: 'offline' }

const notice = (text: string): FmtStep => ({ ...plainStep(text), lane: NOTICE_LANE })

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(steps: FmtStep[], agent: Agent = CLOUD_AGENT): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <BotTurnView
          turn={{ kind: 'bot', key: 't1', agentName: 'Pilot', agentId: agent.id, model: '', time: '', steps }}
          agentById={new Map([[agent.id, agent]])}
          owner={agent}
          ownerRuntime="claude"
          sessionId="s1"
          streaming={false}
          workOpen={false}
          onToggleWork={() => undefined}
          promptMs={undefined}
        />
      </SWRConfig>
    )
  )
  await act(async () => undefined)
  return host
}

const card = () => host!.querySelector('[data-out-of-credits]')
const buttonNamed = (label: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent === label)

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.role = 'owner'
  mocks.flags = new Set(['billing', 'managed'])
  mocks.daemons = []
  mocks.openModal.mockReset()
})

describe('BotTurnView, out-of-credits failure', () => {
  it.each([
    ['a live webchat failure', plainStep(`⚠️ ${TAG}`)],
    ['an AHP turn error', notice(TAG)],
    ['a reloaded failure row', plainStep(`⚠️ Agent failed to respond: API Error: 402 ${TAG}`)]
  ])('draws the card for %s', async (_name, step) => {
    await render([step])
    expect(card()?.textContent).toContain("Pilot couldn't respond")
    expect(host!.textContent).not.toContain('[ERR:')
    expect(host!.querySelector('[data-agent-bubble]')).toBeNull()
  })

  it('tells a never-funded organization it has no credits yet', async () => {
    await render([plainStep('⚠️ [ERR:never_funded] No credit yet')])
    expect(card()?.textContent).toContain("hasn't added any credits yet")
  })

  it('links an owner to Billing with a return to this conversation', async () => {
    await render([plainStep(`⚠️ ${TAG}`)])
    const link = host!.querySelector('a.dsbtn')
    expect(link?.textContent).toBe('Add credits')
    expect(link?.getAttribute('href')).toBe(`/acme/billing?return=${encodeURIComponent('/acme/sessions/s1?thread=t1')}`)
  })

  it('offers a member the billing link to pass to an owner', async () => {
    mocks.role = 'member'
    await render([plainStep(`⚠️ ${TAG}`)])
    expect(host!.querySelector('a.dsbtn')).toBeNull()
    expect(buttonNamed('Copy billing link')).toBeTruthy()
    expect(card()?.textContent).toContain('Ask an owner to add credits')
  })

  it('opens Edit at Runs on when the org has a machine of its own and the viewer can edit', async () => {
    mocks.daemons = [MACHINE]
    await render([plainStep(`⚠️ ${TAG}`)])
    const move = buttonNamed('Move to your own machine')
    expect(move?.disabled).toBe(false)
    await act(async () => move!.click())
    expect(mocks.openModal).toHaveBeenCalledWith('editAgent', CLOUD_AGENT, { focusSection: 'basics' })
  })

  it.each([
    ['without a machine of its own', [{ ...MACHINE, pool: true }]],
    ['with only a machine awaiting approval', [{ ...MACHINE, approval: { status: 'pending' } }]]
  ])('greys the move out %s', async (_name, daemons) => {
    mocks.daemons = daemons
    await render([plainStep(`⚠️ ${TAG}`)])
    expect(buttonNamed('Move to your own machine')?.disabled).toBe(true)
    expect(card()?.textContent).toContain('No machine of your own is connected yet')
  })

  it('greys the move out while the fleet cannot be read', async () => {
    mocks.daemons = new Error('offline')
    await render([plainStep(`⚠️ ${TAG}`)])
    expect(buttonNamed('Move to your own machine')?.disabled).toBe(true)
  })

  it('offers no move to a viewer who cannot edit the agent', async () => {
    mocks.daemons = [MACHINE]
    await render([plainStep(`⚠️ ${TAG}`)], { ...CLOUD_AGENT, canEdit: false } as Agent)
    expect(card()).toBeTruthy()
    expect(buttonNamed('Move to your own machine')).toBeUndefined()
  })

  it.each([
    ['an agent on a machine', { ...CLOUD_AGENT, placementKind: 'daemon' } as Agent, `⚠️ ${TAG}`],
    ['a deployment without billing', CLOUD_AGENT, `⚠️ ${TAG}`],
    ['another refusal reason', CLOUD_AGENT, '⚠️ [ERR:standing_lapsed] Access paused'],
    ['an untagged failure', CLOUD_AGENT, '⚠️ Agent failed to respond: 402 Payment Required']
  ])('keeps the text for %s', async (name, agent, text) => {
    if (name === 'a deployment without billing') mocks.flags = new Set(['managed'])
    await render([plainStep(text)], agent)
    expect(card()).toBeNull()
    expect(host!.querySelector('[data-agent-bubble]')?.textContent).toContain(text)
  })
})
