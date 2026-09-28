// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  decide: vi.fn(async () => undefined)
}))
vi.mock('@/lib/api', () => ({
  fetchAgentPermissionRequests: vi.fn(async () => mocks.rows),
  decideAgentPermissionRequest: mocks.decide
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'example-org' } }) }))

import { ApprovalRequestsCard } from './ApprovalRequestsCard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  mocks.decide.mockClear()
})

const request = (extra: Record<string, unknown> = {}) => ({
  id: 'request-1',
  agentId: 'example-agent',
  createdAt: '2026-01-01T00:00:00.000Z',
  requesterId: null,
  requesterName: 'Example User',
  command: 'Bash: git push',
  status: 'pending',
  resolvedAt: null,
  ...extra
})

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ApprovalRequestsCard agentId="example-agent" bare />
      </SWRConfig>
    )
  })
}

const buttons = () => [...host!.querySelectorAll('button')].map((button) => button.textContent)
const click = async (label: string) => {
  await act(async () => {
    ;[...host!.querySelectorAll('button')].find((button) => button.textContent === label)!.click()
  })
}

describe('console approval requests', () => {
  it('offers every option the request carries and answers with the chosen one', async () => {
    mocks.rows = [
      request({
        options: [
          { optionId: 'once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'always', name: 'Always Allow', kind: 'allow_always' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' }
        ]
      })
    ]
    await render()
    expect(buttons()).toEqual(['Allow', 'Always Allow', 'Reject'])
    await click('Always Allow')
    expect(mocks.decide).toHaveBeenCalledWith('example-agent', 'request-1', 'allow', 'always')
  })

  it('keeps binary Allow and Deny for a request without options', async () => {
    mocks.rows = [request()]
    await render()
    expect(buttons()).toHaveLength(2)
    await click(buttons()[0]!)
    expect(mocks.decide).toHaveBeenCalledWith('example-agent', 'request-1', 'deny', undefined)
  })
})
