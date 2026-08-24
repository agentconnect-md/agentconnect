// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiOrgId, type SessionAccessProvider, type SessionExternalAccessDto } from '@/lib/api'

const answers = new Map<SessionAccessProvider, SessionExternalAccessDto | Error>()

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchSessionExternalAccess: async (provider: SessionAccessProvider) => {
      const answer = answers.get(provider)
      if (answer === undefined) throw new Error(`no answer staged for ${provider}`)
      if (answer instanceof Error) throw answer
      return answer
    }
  }
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings'
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'owner', orgPath: (path: string) => path })
}))

import { SessionAccessCard } from './SettingsView'

const access = (
  provider: SessionAccessProvider,
  patch: Partial<SessionExternalAccessDto> = {}
): SessionExternalAccessDto => ({
  provider,
  available: true,
  enabled: true,
  state: 'enabled',
  currentRevision: '1',
  readFenceRevision: null,
  ...patch
})

/** The deployment cannot offer this provider, and the org is not on it either. */
const nothingToOffer = (provider: SessionAccessProvider) =>
  access(provider, { available: false, enabled: false, state: 'disabled' })

let host: HTMLDivElement
let root: Root

async function render() {
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SessionAccessCard orgId="org-test" isOwner />
      </SWRConfig>
    )
  })
  // One more turn for the three reads to settle and the card to commit.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function rowNames(): string[] {
  return ['Slack', 'GitHub', 'Feishu/Lark'].filter((name) =>
    [...host.querySelectorAll('span')].some((span) => span.textContent === name)
  )
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setApiOrgId('org-test')
  answers.clear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setApiOrgId(null)
})

describe('session access card', () => {
  it('lists every provider the deployment can offer', async () => {
    answers.set('slack', access('slack'))
    answers.set('github', access('github', { enabled: false, state: 'disabled' }))
    answers.set('feishu', access('feishu'))

    await render()

    expect(rowNames()).toEqual(['Slack', 'GitHub', 'Feishu/Lark'])
    expect(host.querySelectorAll('[role="switch"]')).toHaveLength(3)
  })

  it('leaves out a provider this deployment cannot offer, rather than showing a dead switch', async () => {
    answers.set('slack', access('slack'))
    answers.set('github', nothingToOffer('github'))
    answers.set('feishu', nothingToOffer('feishu'))

    await render()

    expect(rowNames()).toEqual(['Slack'])
    expect(host.textContent).not.toContain('Not configured')
  })

  it('renders nothing at all — not even the card — when no provider is on offer', async () => {
    for (const provider of ['slack', 'github', 'feishu'] as const) answers.set(provider, nothingToOffer(provider))

    await render()

    expect(host.textContent).toBe('')
  })

  it('keeps a provider stranded by lost configuration so its switch can still be turned off', async () => {
    answers.set('slack', access('slack', { available: false, enabled: true }))
    answers.set('github', nothingToOffer('github'))
    answers.set('feishu', nothingToOffer('feishu'))

    await render()

    expect(rowNames()).toEqual(['Slack'])
    expect(host.textContent).toContain('Not configured')
    // Off is the only move left, and it must stay available: the CP rejects
    // enabling an unavailable provider but always accepts disabling one.
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')
    expect(toggle?.disabled).toBe(false)
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
  })

  it('keeps a provider whose state could not be read — absence has to be a fact', async () => {
    answers.set('slack', new Error('control plane unreachable'))
    answers.set('github', nothingToOffer('github'))
    answers.set('feishu', nothingToOffer('feishu'))

    await render()

    expect(rowNames()).toEqual(['Slack'])
    expect(host.textContent).toContain('Could not load Slack session access.')
  })
})
