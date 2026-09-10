// @vitest-environment happy-dom
//
// A delegated write never executes in the agent's own request: it answers with an
// operationId and the turn ends. So a decision the owner makes here is news only
// this card can deliver — `onDecided` is what lets the conversation carry a
// multi-step flow past its first write, and it must fire exactly when the outcome
// is actually known.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const decide = vi.fn()
const get = vi.fn()
const list = vi.fn()

vi.mock('@/lib/api', () => ({
  decideWebchatMcpOperation: (...args: unknown[]) => decide(...args),
  getWebchatMcpOperation: (...args: unknown[]) => get(...args),
  listWebchatMcpOperations: (...args: unknown[]) => list(...args)
}))

const { WebchatMcpApprovalCard, approvalNotice } = await import('./WebchatMcpApprovalCard')

const PENDING = {
  operationId: 'e6229709-3d5a-432b-a7d3-613395a7d7ed',
  toolName: 'createAgent',
  arguments: { name: 'code-reviewer' },
  status: 'awaiting_confirmation' as const,
  createdAt: '2026-09-10T04:00:00.000Z',
  confirmationExpiresAt: '2026-09-10T04:10:00.000Z',
  completedAt: null
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  decide.mockReset()
  get.mockReset()
  list.mockReset()
  list.mockResolvedValue([PENDING])
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(onDecided: ReturnType<typeof vi.fn>): Promise<void> {
  await act(async () => {
    root.render(<WebchatMcpApprovalCard orgId="org1" agentId="agent1" conversationId="conv1" onDecided={onDecided} />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

function clickButton(label: string): void {
  const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
  if (!button) throw new Error(`no button labelled ${label}; saw ${host.textContent}`)
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('WebchatMcpApprovalCard', () => {
  it('tells the conversation once the decision has a known outcome', async () => {
    const onDecided = vi.fn()
    decide.mockResolvedValue({ ...PENDING, status: 'completed', completedAt: '2026-09-10T04:01:00.000Z' })
    await render(onDecided)
    clickButton('Approve')
    await act(async () => {
      await Promise.resolve()
    })
    expect(onDecided).toHaveBeenCalledTimes(1)
    expect(onDecided.mock.calls[0]![1]).toBe('approve')
    expect(onDecided.mock.calls[0]![2]).toMatchObject({ status: 'completed' })
  })

  it('stays silent while the operation is still running — that is not an outcome', async () => {
    const onDecided = vi.fn()
    decide.mockResolvedValue({ ...PENDING, status: 'executing' })
    await render(onDecided)
    clickButton('Approve')
    await act(async () => {
      await Promise.resolve()
    })
    expect(onDecided).not.toHaveBeenCalled()
  })

  it('reports a denial too: the agent is waiting on that answer just as much', async () => {
    const onDecided = vi.fn()
    decide.mockResolvedValue({ ...PENDING, status: 'failed', completedAt: '2026-09-10T04:01:00.000Z' })
    await render(onDecided)
    clickButton('Deny')
    await act(async () => {
      await Promise.resolve()
    })
    expect(onDecided.mock.calls[0]![1]).toBe('deny')
  })

  it('recovers a lost decision response through the exact-operation refetch', async () => {
    const onDecided = vi.fn()
    decide.mockRejectedValue(new Error('network'))
    get.mockResolvedValue({ ...PENDING, status: 'completed', completedAt: '2026-09-10T04:01:00.000Z' })
    await render(onDecided)
    clickButton('Approve')
    await act(async () => {
      await Promise.resolve()
    })
    expect(onDecided).toHaveBeenCalledTimes(1)
    expect(onDecided.mock.calls[0]![2]).toMatchObject({ status: 'completed' })
  })
})

describe('approvalNotice', () => {
  it('names the tool, the operation and the state the agent must act on', () => {
    const notice = approvalNotice(PENDING, 'approve', { ...PENDING, status: 'completed' })
    expect(notice).toContain('createAgent')
    expect(notice).toContain(PENDING.operationId)
    expect(notice).toContain('completed')
    expect(notice).toContain('getOperation')
    // The bounded tool payload stays out of the transcript: the agent reads it.
    expect(notice.length).toBeLessThan(200)
  })

  it('separates a denial from an execution failure, which the DTO alone cannot', () => {
    const failed = { ...PENDING, status: 'failed' as const }
    expect(approvalNotice(PENDING, 'deny', failed)).toContain('denied')
    expect(approvalNotice(PENDING, 'approve', failed)).toContain('failed')
  })
})
