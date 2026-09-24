// @vitest-environment happy-dom

// A repository family's routing entry: + Decision opens the rules, Save PUTs them, × DELETEs them, and a refusal or a stale routing shows in place.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeHostRoutingDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  mockMode: true,
  fetchCodeHostRouting: vi.fn(),
  saveCodeHostRouting: vi.fn(),
  deleteCodeHostRouting: vi.fn()
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/agents/a1',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({
  ...(await original<object>()),
  get MOCK_MODE() {
    return mocks.mockMode
  }
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'owner', orgPath: (path: string) => path })
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  const { createDecisionMockApi } = await import('@/lib/decisions/mock-api')
  return {
    ...actual,
    createDecisionApi: () => ({ ...createDecisionMockApi(), mode: 'live' as const }),
    fetchCodeHostRouting: mocks.fetchCodeHostRouting,
    saveCodeHostRouting: mocks.saveCodeHostRouting,
    deleteCodeHostRouting: mocks.deleteCodeHostRouting
  }
})

import { ApiError } from '@/lib/api'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import {
  codeHostScopeId,
  resetCodeHostRoutingMock,
  routingTargets,
  useCodeHostRoutings,
  type CodeHostRoutingScope
} from '@/lib/decisions/code-host-routing'
import { CodeHostDecisionEntry } from './CodeHostDecisionEntry'

let root: Root | undefined
let container: HTMLDivElement | undefined
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const members = [
  { agentId: 'a1', hookId: 'h1', name: 'review-bot' },
  { agentId: 'a2', hookId: 'h2', name: 'security-bot' }
]
const prScope: CodeHostRoutingScope = { repoId: '42', family: 'pull_request', repoFullName: 'acme/api' }
const issuesScope: CodeHostRoutingScope = { repoId: '42', family: 'issues', repoFullName: 'acme/api' }
const routed = {
  enabled: true,
  decisionId: 'needs-response',
  rules: [
    { id: 'r1', when: { type: 'boolean' as const, values: [true] }, action: { type: 'agent' as const, agentId: 'a2' } }
  ],
  otherwise: { type: 'default_agent' as const }
}

function dto(scope: CodeHostRoutingScope, partial: Partial<CodeHostRoutingDto> = {}): CodeHostRoutingDto {
  return { ...scope, config: null, status: null, members, evaluationAgentId: 'a1', ...partial }
}

function Harness({ scope }: { scope: CodeHostRoutingScope }) {
  const { routings } = useCodeHostRoutings([scope], members)
  const routing = routings[codeHostScopeId(scope)]
  return (
    <CodeHostDecisionEntry routing={routing} agents={routing ? routingTargets(routing.members, () => undefined) : []} />
  )
}

beforeEach(() => {
  mocks.mockMode = true
  resetCodeHostRoutingMock()
  mocks.fetchCodeHostRouting.mockReset()
  mocks.saveCodeHostRouting.mockReset()
  mocks.deleteCodeHostRouting.mockReset()
})
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function render(scope: CodeHostRoutingScope = prScope) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <Harness scope={scope} />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await act(async () => {})
  await act(async () => {})
}

const all = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
async function click(node: Element | undefined | null) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await act(async () => {})
}
const button = (text: string) => all('button').find((node) => node.textContent?.trim() === text)

async function pickRules() {
  await click(button('Decision'))
  await click(all('button[aria-haspopup="menu"]').find((node) => node.textContent?.includes('Select a decision…')))
  await click(all('[role="menuitemradio"]').find((node) => node.textContent?.startsWith('Needs a response')))
  await click(document.body.querySelector('button[aria-label="Target for Yes"]'))
  await click(all('[role="menuitemradio"]').find((node) => node.textContent?.includes('security-bot')))
}

describe('CodeHostDecisionEntry', () => {
  it('picks reviewers per answer among the members and keeps them as the row’s pill until ×', async () => {
    await render()
    await click(button('Decision'))
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-label')).toBe('acme/api · By decision rules')
    expect(dialog?.textContent).toContain('picks reviewers among review-bot, security-bot')
    expect(dialog?.textContent).not.toContain('Preview')
    await click(button('Cancel'))
    await pickRules()
    await click(button('Save'))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(all('button').some((node) => node.textContent?.trim() === 'Needs a response')).toBe(true)
    await click(
      document.body.querySelector('button[aria-label="Stop using By decision — every PR goes to all agents"]')
    )
    expect(button('Decision')).toBeTruthy()
  })

  it('words an issues row for issues', async () => {
    await render(issuesScope)
    expect(button('Decision')?.getAttribute('title')).toBe(
      'Every issue goes to all agents. Add a decision to pick agents on every update; the rows then run on any update.'
    )
    await click(button('Decision'))
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      'Issues · picks agents among review-bot, security-bot'
    )
  })

  it('PUTs the rules and DELETEs them against the live API', async () => {
    mocks.mockMode = false
    mocks.fetchCodeHostRouting.mockResolvedValue(dto(prScope))
    mocks.saveCodeHostRouting.mockImplementation(async (_repoId, _family, config) =>
      dto(prScope, { config, status: 'enabled' })
    )
    mocks.deleteCodeHostRouting.mockResolvedValue(undefined)
    await render()
    expect(mocks.fetchCodeHostRouting).toHaveBeenCalledWith('42', 'pull_request', 'org-test')
    await pickRules()
    await click(button('Save'))
    expect(mocks.saveCodeHostRouting).toHaveBeenCalledWith(
      '42',
      'pull_request',
      {
        enabled: true,
        decisionId: 'needs-response',
        rules: [
          expect.objectContaining({
            when: { type: 'boolean', values: [true] },
            action: { type: 'agent', agentId: 'a2' }
          })
        ],
        otherwise: { type: 'default_agent' }
      },
      'org-test'
    )
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    await click(
      document.body.querySelector('button[aria-label="Stop using By decision — every PR goes to all agents"]')
    )
    expect(mocks.deleteCodeHostRouting).toHaveBeenCalledWith('42', 'pull_request', 'org-test')
    expect(button('Decision')).toBeTruthy()
  })

  it('keeps the modal open with the server’s rule issues on a 400', async () => {
    mocks.mockMode = false
    mocks.fetchCodeHostRouting.mockResolvedValue(dto(prScope))
    mocks.saveCodeHostRouting.mockRejectedValue(
      new ApiError('invalid', 400, 'INVALID_INPUT', {
        issues: [{ path: ['rules', 0, 'action'], message: 'Target must watch this repository.' }]
      })
    )
    await render()
    await pickRules()
    await click(button('Save'))
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Check the highlighted fields and save again.')
    expect(dialog?.textContent).toContain('Target must watch this repository.')
  })

  it('flags a routing that needs review on its pill and in the modal', async () => {
    mocks.mockMode = false
    mocks.fetchCodeHostRouting.mockResolvedValue(dto(prScope, { config: routed, status: 'needs_review' }))
    await render()
    const pill = all('button').find((node) => node.textContent?.trim() === 'Needs a response')
    expect(pill?.getAttribute('title')).toBe(
      'By decision · Needs a response · Needs review. Click to review the rules.'
    )
    await click(pill)
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
      'New pull requests on this repository are held until you save the rules again.'
    )
  })

  it('renders nothing when the CP cannot serve the scope', async () => {
    mocks.mockMode = false
    mocks.fetchCodeHostRouting.mockRejectedValue(new ApiError('not found', 404))
    await render()
    expect(button('Decision')).toBeUndefined()
  })
})
