// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string
    ) {
      super(message)
    }
  }
  return {
    ApiError,
    rows: [] as unknown[],
    decide: vi.fn(async () => undefined),
    fetchRequests: vi.fn(async (): Promise<unknown[]> => []),
    proposals: [] as unknown[],
    /** Set: the Control Plane refuses this caller the conversation's proposals. */
    proposalsRefusal: null as Error | null,
    fetchProposals: vi.fn(async (_agentId: string, _sessionId: string): Promise<unknown> => undefined),
    decideProposal: vi.fn(
      async (_agentId: string, _sessionId: string, _draftId: string, _decision: string): Promise<unknown> => ({
        status: 'executing',
        failure: null
      })
    )
  }
})
mocks.fetchRequests.mockImplementation(async () => mocks.rows)
mocks.fetchProposals.mockImplementation(async () => {
  if (mocks.proposalsRefusal) throw mocks.proposalsRefusal
  return { proposals: mocks.proposals, truncated: false }
})
vi.mock('@/lib/api', () => ({
  ApiError: mocks.ApiError,
  fetchAgentPermissionRequests: mocks.fetchRequests,
  decideAgentPermissionRequest: mocks.decide,
  fetchAssistantConversationProposals: mocks.fetchProposals,
  decideAssistantConversationProposal: mocks.decideProposal
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'example-org' }, orgPath: (path: string) => `/example${path}` })
}))
vi.mock('next/link', () => ({
  default: ({ children, className, href }: { children?: ReactNode; className?: string; href?: string }) => (
    <a className={className} href={href}>
      {children}
    </a>
  )
}))

import { ApprovalRequestsCard } from './ApprovalRequestsCard'
import { CONSOLE_SWR_CONFIG } from '@/lib/console-swr'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  mocks.decide.mockClear()
  mocks.fetchRequests.mockClear()
  mocks.fetchProposals.mockClear()
  mocks.decideProposal.mockClear()
  mocks.proposals = []
  mocks.proposalsRefusal = null
})

// The console's own retry policy, so a failed read behaves here as it does in the app.
const swrConfig = { ...CONSOLE_SWR_CONFIG, provider: () => new Map(), dedupingInterval: 0 }

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

async function render(sessionId?: string) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <SWRConfig value={swrConfig}>
        <ApprovalRequestsCard agentId="example-agent" bare {...(sessionId ? { sessionId } : {})} />
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

  it('shows a conversation what its task asks, linked to that task', async () => {
    mocks.rows = [
      request({ id: 'own', sessionId: 'sid-parent', command: 'Bash: ls' }),
      request({ id: 'child', sessionId: 'sid-sub', parentSessionId: 'sid-parent', command: 'Write src/app.ts' }),
      request({ id: 'elsewhere', sessionId: 'sid-other', parentSessionId: 'sid-other-parent', command: 'Bash: rm' })
    ]
    await render('sid-parent')
    expect(host!.textContent).toContain('Bash: ls')
    expect(host!.textContent).toContain('Write src/app.ts')
    expect(host!.textContent).not.toContain('Bash: rm')
    const links = [...host!.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])
    expect(links).toEqual([['Task', '/example/sessions/sid-sub']])
    expect(buttons()).toHaveLength(4)

    // The task's own page shows it as its own request, with no link back to itself.
    act(() => root?.unmount())
    host?.remove()
    await render('sid-sub')
    expect(host!.textContent).toContain('Write src/app.ts')
    expect(host!.textContent).not.toContain('Bash: ls')
    expect(host!.querySelectorAll('a')).toHaveLength(0)
  })
})

/** A patrol's proposal waiting in the webchat conversation `sid-webchat`. */
const proposal = (extra: Record<string, unknown> = {}) => ({
  id: 'proposal-1',
  sentence: 'I want to rebase PR #12 because it conflicts with main.',
  why: 'The check found a merge conflict.',
  task: 'Rebase PR #12 onto main and push.',
  itemId: 'item-1',
  itemTitle: 'Land PR #12',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  ...extra
})

/** The composer strip of the webchat conversation `sid-webchat`, as an editor or as someone who may only continue it. */
async function renderStrip(permissions: boolean) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <SWRConfig value={swrConfig}>
        <ApprovalRequestsCard
          agentId="example-agent"
          sessionId="sid-webchat"
          pendingOnly
          permissions={permissions}
          proposals
        />
      </SWRConfig>
    )
  })
  await act(async () => {})
}

const row = (id: string) => host!.querySelector<HTMLElement>(`[data-conversation-proposal="${id}"]`)
/** Press a proposal row's own button by its label, then its confirm strip's confirm. */
const choose = async (id: string, label: 'Approve' | 'Deny') => {
  const choice = [...row(id)!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)
  await act(async () => choice!.click())
}
const confirm = async (id: string) => {
  await act(async () => row(id)!.querySelector<HTMLButtonElement>('[role="group"] button')!.click())
}

describe('a webchat conversation’s proposals in its pending-requests strip', () => {
  it('shows the conversation’s owner its proposals and nothing an editor alone answers', async () => {
    mocks.rows = [request({ sessionId: 'sid-webchat' })]
    mocks.proposals = [proposal()]
    await renderStrip(false)
    expect(mocks.fetchRequests).not.toHaveBeenCalled()
    expect(mocks.fetchProposals).toHaveBeenCalledWith('example-agent', 'sid-webchat')
    expect(host!.textContent).not.toContain('Bash: git push')
    const shown = row('proposal-1')!
    // The sentence leads, the item and the expiry follow, and the reason and the task stay folded.
    expect(shown.textContent).toContain('Proposal')
    expect(shown.textContent).toContain('I want to rebase PR #12 because it conflicts with main.')
    expect(shown.textContent).toContain('For Land PR #12')
    expect(shown.textContent).toContain('Expires Jan 2, 2026')
    expect(shown.textContent).not.toContain('The check found a merge conflict.')
    expect(shown.textContent).not.toContain('Rebase PR #12 onto main and push.')
    await click('Reason and details')
    expect(shown.textContent).toContain('Why: The check found a merge conflict.')
    expect(shown.textContent).toContain('Rebase PR #12 onto main and push.')
    expect(host!.textContent).toContain('1 pending')
  })

  it('approves one only after a confirmation, then says it runs in the background here', async () => {
    mocks.proposals = [proposal()]
    await renderStrip(false)
    await click('Approve')
    expect(mocks.decideProposal).not.toHaveBeenCalled()
    expect(host!.textContent).toContain('Run this now? It reports back in this conversation.')
    await click('Cancel')
    expect(mocks.decideProposal).not.toHaveBeenCalled()

    await choose('proposal-1', 'Approve')
    mocks.proposals = []
    await confirm('proposal-1')
    expect(mocks.decideProposal).toHaveBeenCalledWith('example-agent', 'sid-webchat', 'proposal-1', 'approve')
    expect(row('proposal-1')!.textContent).toContain(
      'Approved. It runs as a task and reports back in this conversation.'
    )
    expect(buttons()).not.toContain('Approve')
    // Dismissed, nothing is left to show.
    await act(async () => row('proposal-1')!.querySelector<HTMLElement>('[aria-label="Dismiss"]')!.click())
    expect(host!.textContent).toBe('')
  })

  it('shows a follow-up form as the follow-up it takes, and once approved says this conversation lists it', async () => {
    mocks.proposals = [
      proposal({
        task: 'The release date',
        followUp: { title: 'The release date', doneWhen: 'A date is posted.', nextCheck: null }
      })
    ]
    mocks.decideProposal.mockResolvedValueOnce({
      status: 'succeeded',
      failure: null,
      followUp: { id: 'item-taken', conversation: null }
    })
    await renderStrip(false)
    await click('Reason and details')
    const shown = row('proposal-1')!.querySelector('[data-proposed-follow-up]')!
    expect(shown.textContent).toContain('Takes this follow-up')
    expect(shown.textContent).toContain('Done when: A date is posted.')
    expect(shown.textContent).toContain('No check until it is messaged')
    await choose('proposal-1', 'Approve')
    expect(host!.textContent).toContain(
      'Take this follow-up in this conversation? It is followed up for you, and nothing else runs.'
    )
    await confirm('proposal-1')
    expect(row('proposal-1')!.textContent).toContain(
      'Approved. The follow-up was taken; this conversation’s Tasks list it.'
    )
  })

  it('denies one after a confirmation, and says a proposal decided elsewhere first is no longer its to decide', async () => {
    mocks.proposals = [proposal(), proposal({ id: 'proposal-2', sentence: 'I want to close PR #9.' })]
    mocks.decideProposal.mockResolvedValueOnce({ status: 'denied', failure: null })
    await renderStrip(false)
    await choose('proposal-1', 'Deny')
    expect(row('proposal-1')!.textContent).toContain('Deny this proposal? Nothing is run.')
    await confirm('proposal-1')
    expect(mocks.decideProposal).toHaveBeenLastCalledWith('example-agent', 'sid-webchat', 'proposal-1', 'deny')
    expect(row('proposal-1')!.textContent).toContain('Denied. Nothing was run.')

    mocks.decideProposal.mockRejectedValueOnce(new mocks.ApiError('decided', 409, 'DRAFT_ALREADY_DECIDED'))
    await choose('proposal-2', 'Approve')
    await confirm('proposal-2')
    expect(row('proposal-2')!.textContent).toContain('Already decided.')
  })

  it('keeps one waiting with its choices while the agent runs as many tasks as it may', async () => {
    mocks.proposals = [proposal()]
    const limit = 'The agent already has 3 tasks running; approve again once one finishes.'
    mocks.decideProposal.mockRejectedValueOnce(new mocks.ApiError(limit, 409, 'SUBSESSION_LIMIT'))
    await renderStrip(false)
    await choose('proposal-1', 'Approve')
    await confirm('proposal-1')
    expect(row('proposal-1')!.textContent).toContain(limit)
    expect(buttons()).toContain('Approve')
  })

  it('shows an editor the conversation’s permission requests beside its proposals', async () => {
    mocks.rows = [request({ sessionId: 'sid-webchat' })]
    mocks.proposals = [proposal()]
    await renderStrip(true)
    expect(host!.textContent).toContain('Bash: git push')
    expect(row('proposal-1')!.textContent).toContain('I want to rebase PR #12 because it conflicts with main.')
    expect(host!.textContent).toContain('2 pending')
  })

  it('picks up what arrives after a failed read without leaving the page', async () => {
    vi.useFakeTimers()
    try {
      const offline = () => new mocks.ApiError('owning daemon is offline', 503, 'DAEMON_OFFLINE')
      mocks.fetchRequests.mockRejectedValueOnce(offline())
      mocks.fetchProposals.mockRejectedValueOnce(offline())
      await renderStrip(true)
      expect(host!.textContent).toBe('')
      mocks.rows = [request({ sessionId: 'sid-webchat' })]
      mocks.proposals = [proposal()]
      await act(async () => vi.advanceTimersByTimeAsync(15_000))
      expect(host!.textContent).toContain('Bash: git push')
      expect(row('proposal-1')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops asking once the Control Plane refuses', async () => {
    vi.useFakeTimers()
    try {
      mocks.proposalsRefusal = new mocks.ApiError('forbidden', 403)
      await renderStrip(false)
      await act(async () => vi.advanceTimersByTimeAsync(30_000))
      expect(mocks.fetchProposals).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows nothing to someone the Control Plane refuses, and nothing when none waits', async () => {
    mocks.proposalsRefusal = new mocks.ApiError('forbidden', 403)
    await renderStrip(false)
    expect(host!.textContent).toBe('')
    act(() => root?.unmount())
    host?.remove()
    mocks.proposalsRefusal = null
    await renderStrip(false)
    expect(host!.textContent).toBe('')
  })
})
