// @vitest-environment happy-dom
// The assistant-mode Activity view: what everyone who can view the agent sees, what only its editors see and do.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AssistantDraftDto,
  AssistantGrantDto,
  AssistantItemDetailDto,
  AssistantItemDto,
  AssistantSubsessionDto
} from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const AGENT = 'agent-1'
const INTEGRATION = 'int-1'

const mocks = vi.hoisted(() => ({
  open: [] as unknown[],
  closed: [] as unknown[],
  detail: null as unknown,
  subsessions: [] as unknown[],
  drafts: [] as unknown[],
  grants: [] as unknown[],
  failure: null as Error | null,
  outcome: { status: 'succeeded', alwaysAllowed: false, failure: null } as unknown,
  decideFailure: null as Error | null
}))

const api = vi.hoisted(() => ({
  fetchAssistantItems: vi.fn(async (_agentId: string, section: 'open' | 'closed') => {
    if (mocks.failure) throw mocks.failure
    return { items: section === 'open' ? mocks.open : mocks.closed, truncated: false }
  }),
  fetchAssistantItem: vi.fn(async () => mocks.detail),
  deleteAssistantItem: vi.fn(async () => undefined),
  fetchAssistantSubsessions: vi.fn(async () => ({ subsessions: mocks.subsessions, truncated: false })),
  fetchAssistantDrafts: vi.fn(async () => ({ drafts: mocks.drafts, truncated: false })),
  fetchAssistantGrants: vi.fn(async () => ({ grants: mocks.grants, truncated: false })),
  revokeAssistantGrant: vi.fn(async () => undefined),
  decideAssistantDraft: vi.fn(async (_agentId: string, _draftId: string, _decision: string) => {
    if (mocks.decideFailure) throw mocks.decideFailure
    return mocks.outcome
  })
}))

vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))
vi.mock('next/link', () => ({
  default: ({ children, className, href }: { children?: ReactNode; className?: string; href?: string }) => (
    <a className={className} href={href}>
      {children}
    </a>
  )
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/example${path}` })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    members: [{ userId: 'usr-2', name: 'Grace', email: 'grace@example.test' }],
    integrations: [
      {
        id: INTEGRATION,
        agentId: AGENT,
        name: 'team',
        platform: 'slack',
        channels: [
          { channelId: 'C0SUPPORT', name: 'support', trigger: 'any' },
          { channelId: 'D0ADA', name: 'Ada', kind: 'im', trigger: 'any' }
        ]
      }
    ]
  })
}))

const { ApiError } = await import('@/lib/api')
const { AssistantActivityPanel } = await import('./AssistantActivityPanel')

const ITEM: AssistantItemDto = {
  id: 'item-1',
  title: 'Ship the release notes',
  status: 'active',
  doneWhen: 'The notes are published',
  nextCheck: '2026-10-10T09:00:00.000Z',
  origin: { platform: 'slack', channel: 'D0ADA' },
  places: [
    { platform: 'slack', channel: 'D0ADA' },
    { platform: 'slack', channel: 'C0SUPPORT' },
    { platform: 'webchat', channel: 'conv-1' }
  ],
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z'
}
const WAITING: AssistantItemDto = {
  ...ITEM,
  id: 'item-2',
  title: 'Wait for the review',
  status: 'waiting',
  nextCheck: null
}
const DONE: AssistantItemDto = { ...ITEM, id: 'item-3', title: 'Rotate the key', status: 'done' }
const DETAIL: AssistantItemDetailDto = {
  ...ITEM,
  summary: 'The draft is in review.',
  observations: [
    { text: 'Review requested', at: '2026-10-09T11:00:00.000Z' },
    { text: 'PR opened', at: '2026-10-09T10:00:00.000Z' }
  ]
}
const SUBSESSIONS: AssistantSubsessionDto[] = [
  {
    sessionId: 'sid-child',
    title: 'Fix the flaky test',
    state: 'open',
    startedAt: '2026-10-09T09:00:00.000Z',
    visible: true,
    canStop: true,
    parent: { sessionId: 'sid-parent', title: 'support', platform: 'slack', channelName: 'support' }
  },
  {
    sessionId: null,
    title: null,
    state: 'failed',
    startedAt: '2026-10-09T08:00:00.000Z',
    visible: false,
    canStop: false,
    parent: null
  }
]
const DRAFT: AssistantDraftDto = {
  id: 'draft-1',
  kind: 'elsewhere',
  target: {
    platform: 'slack',
    integrationId: INTEGRATION,
    channel: 'C0SUPPORT',
    thread: '1700000000.000100',
    name: 'support',
    dm: false,
    external: false
  },
  text: 'The release is out.\n\nNotes are in the docs.',
  offerAlways: true,
  approver: {
    kind: 'member',
    integrationId: INTEGRATION,
    channel: 'D0ADA',
    userId: 'U0ADA',
    consoleUserId: null,
    name: 'Ada'
  },
  createdAt: '2026-10-09T09:00:00.000Z',
  expiresAt: '2026-10-10T09:00:00.000Z'
}
/** A reply drafted in an external place: its card never offers "always allow". */
const REPLY: AssistantDraftDto = {
  ...DRAFT,
  id: 'draft-2',
  kind: 'reply',
  target: { ...DRAFT.target, channel: 'C0SHARED', name: 'shared', external: true },
  text: 'Thanks, we are on it.',
  offerAlways: false
}
const GRANT: AssistantGrantDto = {
  id: 'a'.repeat(32),
  source: { platform: 'webchat', integrationId: null, channel: 'conv-1' },
  target: { platform: 'slack', integrationId: INTEGRATION, channel: 'C0SUPPORT' },
  grantedByName: 'Ada',
  grantedAt: '2026-10-09T09:00:00.000Z'
}

let root: Root | undefined
let container: HTMLDivElement | undefined

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockClear()
  mocks.open = [ITEM, WAITING]
  mocks.closed = [DONE]
  mocks.detail = DETAIL
  mocks.subsessions = SUBSESSIONS
  mocks.drafts = [DRAFT]
  mocks.grants = [GRANT]
  mocks.failure = null
  mocks.outcome = { status: 'succeeded', alwaysAllowed: false, failure: null }
  mocks.decideFailure = null
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function mount(canEdit: boolean) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <AssistantActivityPanel agentId={AGENT} canEdit={canEdit} />
      </SWRConfig>
    )
  })
  await act(async () => {})
  return container
}

const section = (host: HTMLElement, name: string) =>
  host.querySelector<HTMLElement>(`[data-activity-section="${name}"]`)
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy()
  await act(async () => (element as HTMLElement).click())
  await act(async () => {})
}
const button = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label
  )

describe('the Activity view for anyone who can view the agent', () => {
  it('lists open items with what they wait on and where they are followed, and nothing an editor alone sees', async () => {
    const host = await mount(false)
    const items = section(host, 'items')!
    const row = items.querySelector('[data-assistant-item="item-1"]')!
    expect(row.textContent).toContain('Active')
    expect(row.textContent).toContain('Ship the release notes')
    expect(row.textContent).toContain('Done when: The notes are published')
    expect(row.textContent).toContain('Next check Oct 10, 2026')
    expect(row.textContent).toContain('DM with Ada, #support, Webchat')
    expect(items.querySelector('[data-assistant-item="item-2"]')?.textContent).toContain('Waiting')
    expect(items.querySelector('[data-assistant-item="item-2"]')?.textContent).not.toContain('Next check')

    // Read-only: no delete, no drafts, no grants, and neither editor read is made.
    expect(button(host, 'Delete')).toBeUndefined()
    expect(button(host, 'Approve')).toBeUndefined()
    expect(section(host, 'drafts')).toBeNull()
    expect(section(host, 'grants')).toBeNull()
    expect(api.fetchAssistantDrafts).not.toHaveBeenCalled()
    expect(api.fetchAssistantGrants).not.toHaveBeenCalled()
  })

  it('reads observations only when an item is expanded, and closed items only when that section opens', async () => {
    const host = await mount(false)
    expect(api.fetchAssistantItems.mock.calls.map((call) => call[1])).toEqual(['open'])
    expect(api.fetchAssistantItem).not.toHaveBeenCalled()

    await click(button(host.querySelector('[data-assistant-item="item-1"]')!, 'Show observations'))
    expect(api.fetchAssistantItem).toHaveBeenCalledWith(AGENT, 'item-1')
    const detail = host.querySelector('[data-assistant-item-detail]')!
    expect(detail.textContent).toContain('The draft is in review.')
    const observations = [...detail.querySelectorAll('li')].map((li) => li.textContent)
    expect(observations[0]).toContain('Review requested')
    expect(observations[1]).toContain('PR opened')

    expect(section(host, 'items')!.textContent).not.toContain('Rotate the key')
    await click(button(host, 'Done and dropped'))
    expect(api.fetchAssistantItems.mock.calls.map((call) => call[1])).toEqual(['open', 'closed'])
    expect(host.querySelector('[data-assistant-item="item-3"]')?.textContent).toContain('Done')
  })

  it('links the sub-sessions the viewer may open and hides the rest', async () => {
    const host = await mount(false)
    const subsessions = section(host, 'subsessions')!
    const visible = subsessions.querySelector('[data-assistant-subsession="sid-child"]')!
    expect(visible.textContent).toContain('Running')
    const links = [...visible.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])
    expect(links).toEqual([
      ['Fix the flaky test', '/example/sessions/sid-child'],
      ['From #support', '/example/sessions/sid-parent']
    ])
    const hidden = subsessions.querySelector('[data-assistant-subsession="hidden"]')!
    expect(hidden.textContent).toContain('Failed')
    expect(hidden.textContent).toContain('Not visible to you')
    expect(hidden.querySelector('a')).toBeNull()
  })

  it('says when the agent’s daemon is too old to answer', async () => {
    mocks.failure = new ApiError('upgrade', 409, 'DAEMON_FEATURE_MISSING')
    const host = await mount(false)
    expect(section(host, 'items')!.textContent).toContain('Upgrade this agent’s daemon to see its activity.')
  })
})

describe('the Activity view for an editor', () => {
  it('shows each pending draft’s target, exact text, approver and expiry, with the choices its card offers', async () => {
    mocks.drafts = [DRAFT, REPLY]
    const host = await mount(true)
    const draft = section(host, 'drafts')!.querySelector('[data-assistant-draft="draft-1"]')!
    expect(draft.textContent).toContain('To #support · in a thread')
    expect(draft.textContent).toContain('The release is out.\n\nNotes are in the docs.')
    expect(draft.textContent).toContain('Approver: Ada')
    expect(draft.textContent).toContain('Expires Oct 10, 2026')
    const labels = (row: Element) => [...row.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels(draft)).toEqual(['Approve', 'Discard', 'Approve and always allow from here to there'])
    expect(labels(host.querySelector('[data-assistant-draft="draft-2"]')!)).toEqual(['Approve', 'Discard'])
  })

  it('approves a draft after a confirmation, then shows the outcome in place of the choices', async () => {
    const host = await mount(true)
    const draft = host.querySelector('[data-assistant-draft="draft-1"]')!
    await click(button(draft, 'Approve'))
    expect(api.decideAssistantDraft).not.toHaveBeenCalled()
    const confirm = draft.querySelector('[role="group"]')!
    expect(confirm.textContent).toContain('Post this to #support now?')
    await click(button(confirm, 'Approve'))
    expect(api.decideAssistantDraft).toHaveBeenCalledWith(AGENT, 'draft-1', 'approve')
    expect(draft.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe('Posted.')
    expect(draft.querySelector('button')).toBeNull()
    // The section counts what still waits; the decided row stays, showing how it ended.
    expect(section(host, 'drafts')!.querySelector('.badge')).toBeNull()
  })

  it('approves and always allows the route, or discards, each as the card would', async () => {
    mocks.outcome = { status: 'succeeded', alwaysAllowed: true, failure: null }
    const host = await mount(true)
    const draft = host.querySelector('[data-assistant-draft="draft-1"]')!
    await click(button(draft, 'Approve and always allow from here to there'))
    const confirm = draft.querySelector('[role="group"]')!
    expect(confirm.textContent).toContain('Post this to #support now, and always allow from here to there?')
    await click(button(confirm, 'Approve'))
    expect(api.decideAssistantDraft).toHaveBeenCalledWith(AGENT, 'draft-1', 'approve_always')
    expect(draft.textContent).toContain('Posted. Posts from here to there now go out without asking.')

    await act(async () => root?.unmount())
    container?.remove()
    mocks.outcome = { status: 'denied', alwaysAllowed: false, failure: null }
    const again = await mount(true)
    const row = again.querySelector('[data-assistant-draft="draft-1"]')!
    await click(button(row, 'Discard'))
    expect(row.querySelector('[role="group"]')?.textContent).toContain('Discard this draft? Nothing is posted.')
    await click(button(row.querySelector('[role="group"]')!, 'Discard'))
    expect(api.decideAssistantDraft).toHaveBeenLastCalledWith(AGENT, 'draft-1', 'discard')
    expect(row.textContent).toContain('Discarded. Nothing was posted.')
  })

  it('decides nothing when the confirmation is cancelled', async () => {
    const host = await mount(true)
    const draft = host.querySelector('[data-assistant-draft="draft-1"]')!
    await click(button(draft, 'Discard'))
    await click(button(draft, 'Cancel'))
    expect(draft.querySelector('[role="group"]')).toBeNull()
    expect(button(draft, 'Approve')).toBeTruthy()
    expect(api.decideAssistantDraft).not.toHaveBeenCalled()
  })

  it.each([
    [
      { status: 'failed', alwaysAllowed: false, failure: 'the agent is no longer enabled in that conversation' },
      'Couldn’t post: the agent is no longer enabled in that conversation. Nothing was sent.'
    ],
    [
      { status: 'outcome_unknown', alwaysAllowed: false, failure: 'socket hang up' },
      'Not sure this went through. Check the conversation; it won’t be posted again.'
    ]
  ])('says when a post failed or may not have gone through', async (outcome, text) => {
    mocks.outcome = outcome
    const host = await mount(true)
    const draft = host.querySelector('[data-assistant-draft="draft-1"]')!
    await click(button(draft, 'Approve'))
    await click(button(draft.querySelector('[role="group"]')!, 'Approve'))
    expect(draft.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe(text)
  })

  it.each([
    ['DRAFT_EXPIRED', 409, 'Expired. Nothing was posted.'],
    ['DRAFT_ALREADY_DECIDED', 409, 'Already decided.'],
    ['NOT_FOUND', 404, 'No longer waiting for approval.']
  ])('shows a refused decision (%s) in place of the choices', async (code, status, text) => {
    mocks.decideFailure = new ApiError('refused', status, code)
    const host = await mount(true)
    const draft = host.querySelector('[data-assistant-draft="draft-1"]')!
    await click(button(draft, 'Approve'))
    await click(button(draft.querySelector('[role="group"]')!, 'Approve'))
    expect(draft.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe(text)
    expect(draft.querySelector('button')).toBeNull()
  })

  it('keeps the choices after a decision that did not go through, and reads the list again when unconfirmed', async () => {
    mocks.decideFailure = new ApiError('offline', 503, 'DAEMON_OFFLINE')
    const host = await mount(true)
    const draft = host.querySelector('[data-assistant-draft="draft-1"]')!
    await click(button(draft, 'Approve'))
    await click(button(draft.querySelector('[role="group"]')!, 'Approve'))
    expect(draft.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t decide. Try again.')
    expect(button(draft, 'Approve')).toBeTruthy()

    // Unconfirmed, and the next read still lists it: the warning, and the choices to try again.
    mocks.decideFailure = new ApiError('unconfirmed', 503, 'DECISION_UNCONFIRMED')
    const reads = api.fetchAssistantDrafts.mock.calls.length
    await click(button(draft, 'Approve'))
    await click(button(draft.querySelector('[role="group"]')!, 'Approve'))
    expect(api.fetchAssistantDrafts.mock.calls.length).toBeGreaterThan(reads)
    expect(draft.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe(
      'Couldn’t confirm the decision. It is still waiting for approval.'
    )
    expect(draft.querySelector('[role="alert"]')).toBeNull()
    mocks.decideFailure = null
    await click(button(draft, 'Approve'))
    await click(button(draft.querySelector('[role="group"]')!, 'Approve'))
    expect(draft.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe('Posted.')
  })

  it('keeps an unconfirmed row and its warning when the next read no longer lists it', async () => {
    const host = await mount(true)
    const draft = host.querySelector('[data-assistant-draft="draft-1"]')!
    await click(button(draft, 'Approve'))
    // The post began or finished, but its answer was lost: the daemon no longer lists the draft as waiting.
    mocks.drafts = []
    mocks.decideFailure = new ApiError('unconfirmed', 503, 'DECISION_UNCONFIRMED')
    const reads = api.fetchAssistantDrafts.mock.calls.length
    await click(button(draft.querySelector('[role="group"]')!, 'Approve'))
    await act(async () => {})
    expect(api.fetchAssistantDrafts.mock.calls.length).toBeGreaterThan(reads)
    const row = host.querySelector('[data-assistant-draft="draft-1"]')!
    expect(row).not.toBeNull()
    expect(row.textContent).toContain('To #support')
    expect(row.textContent).toContain('The release is out.\n\nNotes are in the docs.')
    expect(row.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe(
      'Couldn’t confirm the decision, and it is no longer waiting. Check the destination; it may have been posted.'
    )
    expect(row.querySelector('button')).toBeNull()
    expect(section(host, 'drafts')!.querySelector('.badge')).toBeNull()
  })

  it('keeps a decided row when a later read no longer lists it', async () => {
    mocks.drafts = [DRAFT, REPLY]
    const host = await mount(true)
    const draft = host.querySelector('[data-assistant-draft="draft-1"]')!
    await click(button(draft, 'Approve'))
    await click(button(draft.querySelector('[role="group"]')!, 'Approve'))
    // An unconfirmed decision on the other draft reads the list again, which no longer holds the first.
    mocks.drafts = [REPLY]
    mocks.decideFailure = new ApiError('unconfirmed', 503, 'DECISION_UNCONFIRMED')
    const reply = host.querySelector('[data-assistant-draft="draft-2"]')!
    const reads = api.fetchAssistantDrafts.mock.calls.length
    await click(button(reply, 'Approve'))
    await click(button(reply.querySelector('[role="group"]')!, 'Approve'))
    expect(api.fetchAssistantDrafts.mock.calls.length).toBeGreaterThan(reads)
    const row = host.querySelector('[data-assistant-draft="draft-1"]')
    expect(row?.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe('Posted.')
    expect(section(host, 'drafts')!.querySelector('.badge')?.textContent).toBe('1')
  })

  it('deletes an item after a confirmation, and drops it from the list', async () => {
    const host = await mount(true)
    const row = host.querySelector('[data-assistant-item="item-1"]')!
    await click(button(row, 'Delete'))
    expect(api.deleteAssistantItem).not.toHaveBeenCalled()
    expect(row.textContent).toContain('Delete this item? The agent stops following it.')
    await click(button(row.querySelector('[role="group"]')!, 'Delete'))
    expect(api.deleteAssistantItem).toHaveBeenCalledWith(AGENT, 'item-1')
    expect(host.querySelector('[data-assistant-item="item-1"]')).toBeNull()
    expect(host.querySelector('[data-assistant-item="item-2"]')).not.toBeNull()
  })

  it('keeps an item when the confirmation is declined', async () => {
    const host = await mount(true)
    const row = host.querySelector('[data-assistant-item="item-1"]')!
    await click(button(row, 'Delete'))
    await click(button(row, 'Keep'))
    expect(row.querySelector('[role="group"]')).toBeNull()
    expect(api.deleteAssistantItem).not.toHaveBeenCalled()
  })

  it('lists the always-allowed routes and revokes one after a confirmation', async () => {
    const host = await mount(true)
    const grant = section(host, 'grants')!.querySelector(`[data-assistant-grant="${GRANT.id}"]`)!
    expect(grant.textContent).toContain('Webchat')
    expect(grant.textContent).toContain('#support')
    expect(grant.textContent).toContain('Allowed by Ada on Oct 9, 2026')
    await click(button(grant, 'Revoke'))
    await click(button(grant.querySelector('[role="group"]')!, 'Revoke'))
    expect(api.revokeAssistantGrant).toHaveBeenCalledWith(AGENT, GRANT.id)
    expect(section(host, 'grants')!.textContent).toContain('No routes are always allowed.')
  })
})

describe('the Activity view on a phone', () => {
  it('stacks each row under one responsive tree and keeps icon-only controls labelled', async () => {
    const host = await mount(true)
    const panel = host.querySelector('[data-assistant-activity]')!
    // Base classes are the phone layout; desktop: variants restore the wide one.
    expect(panel.className).toContain('p-4')
    expect(panel.className).toContain('desktop:p-0')
    const row = host.querySelector('[data-assistant-item="item-1"]')!
    const heading = row.querySelector('.badge')!.parentElement!
    expect(heading.className).toContain('flex-col')
    expect(heading.className).toContain('desktop:flex-row')
    const remove = button(row, 'Delete')!
    expect(remove.getAttribute('aria-label')).toBe('Delete')
    expect(remove.querySelector('span')?.className).toContain('max-desktop:hidden')
    const subsession = host.querySelector('[data-assistant-subsession="sid-child"]')!
    expect(subsession.className).toContain('flex-col')
    expect(subsession.className).toContain('desktop:flex-row')
    // A draft's choices wrap under its text, and so does the confirmation that replaces them.
    const draft = host.querySelector('[data-assistant-draft="draft-1"]')!
    expect(draft.querySelector('[data-assistant-draft-actions]')?.className).toContain('flex-wrap')
    await click(button(draft, 'Approve and always allow from here to there'))
    expect(draft.querySelector('[role="group"]')?.className).toContain('flex-wrap')
  })
})
