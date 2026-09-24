// @vitest-environment happy-dom

// A watched repository's pull-request reviewers By decision (UI preview): + Decision opens the rules, Save keeps them in the tab, × drops them.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import { resetCodeHostReviewDecisions } from '@/lib/decisions/code-host-review-preview'
import type { RosterAgent } from '@/lib/decisions/routing-roster'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/agents/a1',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
// review-bot and security-bot watch acme/api's pull requests; docs-bot watches only its issues.
const hooks: Record<string, object[]> = {
  a1: [{ kind: 'github', name: 'acme/api', repoFullName: 'acme/api', family: 'pull_request', events: [] }],
  a2: [{ kind: 'github', name: 'Acme/API', repoFullName: 'Acme/API', family: 'pull_request', events: [] }],
  a3: [{ kind: 'github', name: 'acme/api', repoFullName: 'acme/api', family: 'issues', events: [] }]
}
vi.mock('@/lib/api', async (original) => ({
  ...(await original<object>()),
  fetchAgentHooks: vi.fn(async (agentId: string) => hooks[agentId] ?? [])
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'owner', orgPath: (path: string) => path })
}))

import { CodeHostDecisionEntry } from './CodeHostDecisionEntry'

let root: Root | undefined
let container: HTMLDivElement | undefined
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const agents: RosterAgent[] = [
  { id: 'a1', name: 'review-bot', available: true, runtime: 'claude' },
  { id: 'a2', name: 'security-bot', available: true, runtime: 'codex' },
  { id: 'a3', name: 'docs-bot', available: true, runtime: 'claude' }
]

beforeEach(() => resetCodeHostReviewDecisions())
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function render(blocked = false) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <CodeHostDecisionEntry storeKey="org-test|acme/api" repo="acme/api" candidates={agents} blocked={blocked} />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
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

describe('CodeHostDecisionEntry', () => {
  it('picks reviewers per answer and keeps them as the row’s pill until ×', async () => {
    await render()
    await click(button('Decision'))
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-label')).toBe('acme/api · By decision rules')
    expect(dialog?.textContent).toContain('picks reviewers among review-bot, security-bot')
    expect(dialog?.textContent).toContain('Preview')
    await click(all('button[aria-haspopup="menu"]').find((node) => node.textContent?.includes('Select a decision…')))
    await click(all('[role="menuitemradio"]').find((node) => node.textContent?.startsWith('Needs a response')))
    await click(document.body.querySelector('button[aria-label="Target for Yes"]'))
    // Only the repository's pull-request watchers are targets.
    const targets = all('[role="menuitemradio"]').map((node) => node.textContent ?? '')
    expect(targets.some((text) => text.includes('security-bot'))).toBe(true)
    expect(targets.some((text) => text.includes('docs-bot'))).toBe(false)
    await click(all('[role="menuitemradio"]').find((node) => node.textContent?.includes('security-bot')))
    await click(button('Save'))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(all('button').some((node) => node.textContent?.trim() === 'Needs a response')).toBe(true)
    await click(
      document.body.querySelector('button[aria-label="Stop using By decision — every PR goes to all agents"]')
    )
    expect(button('Decision')).toBeTruthy()
  })

  it('offers no decision while the row runs on @-mention', async () => {
    await render(true)
    expect((button('Decision') as HTMLButtonElement | undefined)?.disabled).toBe(true)
  })
})
