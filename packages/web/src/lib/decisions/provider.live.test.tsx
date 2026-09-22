// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, expect, it, vi } from 'vitest'
import { DecisionsPrototypeProvider, useDecisionsPrototype } from './provider'
import { createDecisionApi, setApiOrgId } from '@/lib/api'

vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: false }))
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: () => true }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'example-org' } }) }))
const auth = vi.hoisted(() => ({ getToken: async () => undefined, getIdTokenRaw: async () => undefined }))
vi.mock('@/lib/auth', async (original) => ({ ...(await original<object>()), ...auth }))
let root: Root | undefined
let container: HTMLDivElement | undefined
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  setApiOrgId(null)
  vi.unstubAllGlobals()
})

function Probe() {
  const { api, decisions, error } = useDecisionsPrototype()
  return (
    <div>
      {api.mode}:{error ?? decisions.map((decision) => decision.name).join(',')}
    </div>
  )
}

it('uses the live API and surfaces a failed read without installing seeded decisions', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ message: 'Example service unavailable' }, { status: 503 })
  )
  vi.stubGlobal('fetch', fetcher)
  container = document.createElement('div')
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <DecisionsPrototypeProvider>
          <Probe />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await act(async () => {})
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('/orgs/example-org/decisions')
  expect(container.textContent).toBe('live:Example service unavailable')
})

it('keeps writes in the captured organization and propagates a failed preview', async () => {
  const api = createDecisionApi('example-org')
  setApiOrgId('another-org')
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ message: 'Daemon unavailable' }, { status: 503 }))
  vi.stubGlobal('fetch', fetcher)
  const decision = {
    name: 'Reply',
    providerId: 'typesafe',
    model: 'jev-latest',
    question: {
      type: 'boolean' as const,
      instructions: 'Reply?',
      criteria: { true: 'Useful', false: 'Noise' }
    }
  }
  await expect(
    api.preview({ decision, daemonId: 'example-daemon', state: { text: 'Example' }, consumer: { type: 'none' } })
  ).rejects.toMatchObject({ status: 503 })
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('/orgs/example-org/decisions/preview')
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).decision.model).toBe('jev-latest')
  await expect(api.createDecision(decision)).rejects.toMatchObject({ status: 503 })
  expect(String(fetcher.mock.calls[1]?.[0])).toContain('/orgs/example-org/decisions')
})
