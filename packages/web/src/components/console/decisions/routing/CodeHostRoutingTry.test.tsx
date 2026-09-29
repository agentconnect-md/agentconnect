// @vitest-environment happy-dom

// Repository routing Try: the provider's template state reaches the scope's preview, and each outcome names the agents it fires.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodeHostRoutingDto } from '@/lib/api'
import type { CodeHostRoutingPreviewResult } from '@agentconnect.md/protocol/decision-api'

const mocks = vi.hoisted(() => ({ previewCodeHostRouting: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/agents/a1',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'owner', orgPath: (path: string) => path })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  previewCodeHostRouting: mocks.previewCodeHostRouting
}))

import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import { draftConfig, draftFromDetail } from '@/lib/decisions/routing-draft'
import { CodeHostRoutingTry } from './CodeHostRoutingTry'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.clearAllMocks()
})

const seed = createDecisionMockSeed()
const decision = seed.decisions[0]!
const draft = draftFromDetail({ config: seed.routings[0]!.config, channelIds: [] })
const agents = seed.bots[0]!.agents.map((agent) => ({ ...agent, runtime: '' }))
const routing = (family: 'issues' | 'pull_request'): CodeHostRoutingDto => ({
  provider: 'github',
  repoId: '42',
  family,
  repoFullName: 'example-org/example-repo',
  config: null,
  status: null,
  members: agents.map((agent, index) => ({ agentId: agent.id, hookId: `h${index}`, name: agent.name })),
  evaluationAgentId: null
})
const consumer = (over: Partial<CodeHostRoutingPreviewResult['consumer']>): CodeHostRoutingPreviewResult => ({
  mode: 'live',
  evaluation: {
    status: 'answered',
    model: 'jev-1.13.0',
    answer: {
      type: 'choice',
      value: 'billing',
      probabilities: { billing: 0.8, technical: 0.1, sales: 0.1 },
      confidence: 0.8
    },
    usage: { inputTokens: 10, outputTokens: 1 }
  },
  consumer: {
    type: 'code_host_routing',
    outcome: 'activate',
    matchedRuleIds: [],
    matchedKeys: [],
    usedOtherwise: false,
    targets: [],
    ...over
  }
})

async function render(family: 'issues' | 'pull_request') {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <CodeHostRoutingTry
            routing={routing(family)}
            draft={draft}
            config={draftConfig(draft)!}
            decision={decision}
            agents={agents}
            open
          />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  )
  return container
}
async function type(field: HTMLTextAreaElement | null, value: string) {
  if (!field) throw new Error('no field')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function tryIt(view: HTMLElement) {
  const button = [...view.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Try')
  await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await act(async () => {})
}
const result = (view: ParentNode) => view.querySelector('[data-testid="try-result"]')?.textContent ?? ''

describe('CodeHostRoutingTry', () => {
  it("sends the scope's pull request template with the edited message and names the agents it fires", async () => {
    mocks.previewCodeHostRouting.mockResolvedValue(
      consumer({ matchedRuleIds: [draft.rules[0]!.id], targets: [{ agentId: agents[0]!.id, name: agents[0]!.name }] })
    )
    const view = await render('pull_request')
    expect(view.textContent).toContain('"pullRequest":')
    expect(view.querySelector('[title^="Filled in here"]')?.getAttribute('title')).toContain('repository')
    await type(view.querySelector('textarea[aria-label="Current message"]'), 'Please review the config change')
    await tryIt(view)
    expect(mocks.previewCodeHostRouting).toHaveBeenCalledWith(
      { provider: 'github', repoId: '42', family: 'pull_request' },
      {
        config: draftConfig(draft),
        state: expect.objectContaining({
          event: { name: 'pull_request', action: 'opened' },
          subject: expect.objectContaining({ kind: 'pull_request', draft: false }),
          currentMessage: { sender: { id: 'reporter', association: 'NONE' }, text: 'Please review the config change' },
          pullRequest: expect.objectContaining({ files: [expect.objectContaining({ path: 'src/config.ts' })] })
        })
      },
      'org-test'
    )
    expect(result(view)).toContain('Would activate')
    expect(result(view)).toContain(`Agents${agents[0]!.name}`)
  })

  it('says every agent takes the event when the evaluation is unavailable, never a skip', async () => {
    mocks.previewCodeHostRouting.mockResolvedValue({
      ...consumer({
        outcome: 'unavailable',
        reason: 'timeout',
        targets: agents.map((agent) => ({ agentId: agent.id, name: agent.name }))
      }),
      evaluation: { status: 'unavailable', reason: 'timeout' }
    })
    const view = await render('issues')
    expect(view.textContent).not.toContain('"pullRequest":')
    await type(view.querySelector('textarea[aria-label="Current message"]'), 'It crashes')
    await tryIt(view)
    expect(result(view)).toContain('Evaluation unavailable')
    expect(result(view)).toContain('Every agent takes the event')
    expect(result(view)).not.toContain('Would not activate')
  })
})
