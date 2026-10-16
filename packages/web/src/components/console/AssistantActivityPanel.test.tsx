// @vitest-environment happy-dom
// The Activity view: what everyone who can view the agent sees, what only its editors see and do, in assistant mode or not.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AssistantDraftDto,
  AssistantItemDetailDto,
  AssistantItemDto,
  AssistantPermissionRequestDto,
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
  /** Unset: a daemon without `follow-up-tasks-v1`. */
  followUps: undefined as boolean | undefined,
  subsessionsFailure: null as Error | null,
  stopAnswer: { result: 'stopped' } as unknown,
  drafts: [] as unknown[],
  /** Unset: a Control Plane that does not list tasks' permission requests. */
  permissions: undefined as unknown[] | undefined,
  failure: null as Error | null,
  outcome: { status: 'succeeded', failure: null } as unknown,
  decideFailure: null as Error | null,
  permissionFailure: null as Error | null
}))

const api = vi.hoisted(() => ({
  fetchAssistantItems: vi.fn(async (_agentId: string, section: 'open' | 'closed') => {
    if (mocks.failure) throw mocks.failure
    return { items: section === 'open' ? mocks.open : mocks.closed, truncated: false }
  }),
  fetchAssistantItem: vi.fn(async () => mocks.detail),
  deleteAssistantItem: vi.fn(async () => undefined),
  fetchAssistantSubsessions: vi.fn(async () => {
    if (mocks.subsessionsFailure) throw mocks.subsessionsFailure
    return {
      subsessions: mocks.subsessions,
      truncated: false,
      ...(mocks.followUps === undefined ? {} : { followUps: mocks.followUps })
    }
  }),
  stopAssistantSubsession: vi.fn(async (_agentId: string, _sessionId: string) => mocks.stopAnswer),
  stopAssistantFollowUp: vi.fn(
    async (_agentId: string, _followUpId: string, _parentSessionId: string) => mocks.stopAnswer
  ),
  fetchAssistantDrafts: vi.fn(async () => ({
    drafts: mocks.drafts,
    truncated: false,
    ...(mocks.permissions ? { permissionRequests: mocks.permissions } : {})
  })),
  decideAgentPermissionRequest: vi.fn(
    async (_agentId: string, _requestId: string, _decision: string, _optionId?: string) => {
      if (mocks.permissionFailure) throw mocks.permissionFailure
    }
  ),
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
const { default: chinese } = await import('../../../messages/zh-CN.json')

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
/** A daemon with `follow-up-tasks-v1`: a follow-up the viewer may see and end, a hidden one, an ended one, and a delegated task. */
const FOLLOW_UPS: AssistantSubsessionDto[] = [
  {
    sessionId: 'sid-follow',
    title: 'Watch the release',
    state: 'open',
    startedAt: '2026-10-09T09:00:00.000Z',
    visible: true,
    canStop: true,
    parent: { sessionId: 'sid-parent', title: 'support', platform: 'slack', channelName: 'support' },
    kind: 'follow-up',
    followUp: {
      status: 'waiting',
      nextCheck: '2026-10-16T09:00:00.000Z',
      doneWhen: 'The release is published',
      recentChecks: [{ at: '2026-10-15T09:00:00.000Z', observation: 'Still a draft.', reported: true }]
    }
  },
  {
    sessionId: null,
    title: null,
    state: 'open',
    startedAt: '2026-10-08T09:00:00.000Z',
    visible: false,
    canStop: false,
    parent: null,
    kind: 'follow-up',
    followUp: { status: 'paused', nextCheck: null, doneWhen: null, recentChecks: [] }
  },
  {
    sessionId: 'sid-ended',
    title: 'Rotate the key',
    state: 'done',
    startedAt: '2026-10-07T09:00:00.000Z',
    visible: true,
    canStop: false,
    parent: null,
    kind: 'follow-up',
    followUp: { status: 'stopped', nextCheck: null, doneWhen: 'The key is rotated', recentChecks: [] }
  },
  { ...SUBSESSIONS[0]!, kind: 'delegated' }
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
/** A reply drafted in an external place. */
const REPLY: AssistantDraftDto = {
  ...DRAFT,
  id: 'draft-2',
  kind: 'reply',
  target: { ...DRAFT.target, channel: 'C0SHARED', name: 'shared', external: true },
  text: 'Thanks, we are on it.'
}
/** A scheduled check's proposal: the task is its text, and approval runs it in the item's conversation. */
const PROPOSAL: AssistantDraftDto = {
  id: 'proposal-1',
  kind: 'task',
  target: {
    platform: 'slack',
    integrationId: INTEGRATION,
    channel: 'C0SUPPORT',
    thread: null,
    name: 'support',
    dm: false,
    external: false
  },
  text: 'Rebase PR #12 onto main and push.',
  approver: {
    kind: 'conversation',
    integrationId: INTEGRATION,
    channel: 'C0SUPPORT',
    userId: null,
    consoleUserId: null,
    name: null
  },
  proposal: {
    sentence: 'I want to rebase PR #12 because it conflicts with main.',
    why: 'The check found a merge conflict.',
    itemId: 'item-1',
    itemTitle: 'Ship the release notes'
  },
  createdAt: '2026-10-09T09:00:00.000Z',
  expiresAt: '2026-10-10T09:00:00.000Z'
}
/** Background work waiting for permission, with the options its runtime offered. */
const PERMISSION: AssistantPermissionRequestDto = {
  requestId: 'request-1',
  tool: 'Write src/app.ts',
  createdAt: '2026-10-09T09:00:00.000Z',
  expiresAt: '2026-10-09T21:00:00.000Z',
  options: [
    { optionId: 'o-always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'o-allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'o-deny', name: 'Deny', kind: 'reject_once' }
  ],
  subsession: { sessionId: 'sid-child', title: 'Fix the flaky test' },
  parent: { sessionId: 'sid-parent', title: 'support', platform: 'slack', channelName: 'support' }
}
/** One the viewer may not open, asking for a plain Allow or Deny. */
const HIDDEN_PERMISSION: AssistantPermissionRequestDto = {
  ...PERMISSION,
  requestId: 'request-2',
  options: undefined,
  subsession: null,
  parent: null
}

let root: Root | undefined
let container: HTMLDivElement | undefined

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockClear()
  mocks.open = [ITEM, WAITING]
  mocks.closed = [DONE]
  mocks.detail = DETAIL
  mocks.subsessions = SUBSESSIONS
  mocks.followUps = undefined
  mocks.subsessionsFailure = null
  mocks.stopAnswer = { result: 'stopped' }
  mocks.drafts = [DRAFT]
  mocks.permissions = undefined
  mocks.failure = null
  mocks.outcome = { status: 'succeeded', failure: null }
  mocks.decideFailure = null
  mocks.permissionFailure = null
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function mount(canEdit: boolean, assistant = true, wrap: (node: ReactNode) => ReactNode = (node) => node) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      wrap(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <AssistantActivityPanel agentId={AGENT} canEdit={canEdit} assistant={assistant} />
        </SWRConfig>
      )
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

    // Read-only: no delete, no drafts, and the editor read is not made.
    expect(button(host, 'Delete')).toBeUndefined()
    expect(button(host, 'Approve')).toBeUndefined()
    expect(section(host, 'drafts')).toBeNull()
    expect(api.fetchAssistantDrafts).not.toHaveBeenCalled()
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

  it('links the tasks the viewer may open and hides the rest', async () => {
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
  it('shows each pending draft’s target, exact text, approver and expiry, with its choices', async () => {
    mocks.drafts = [DRAFT, REPLY]
    const host = await mount(true)
    const draft = section(host, 'drafts')!.querySelector('[data-assistant-draft="draft-1"]')!
    expect(draft.textContent).toContain('To #support · in a thread')
    expect(draft.textContent).toContain('The release is out.\n\nNotes are in the docs.')
    expect(draft.textContent).toContain('Approver: Ada')
    expect(draft.textContent).toContain('Expires Oct 10, 2026')
    const labels = (row: Element) => [...row.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels(draft)).toEqual(['Approve', 'Discard'])
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

  it('discards a draft after a confirmation, posting nothing', async () => {
    mocks.outcome = { status: 'denied', failure: null }
    const host = await mount(true)
    const row = host.querySelector('[data-assistant-draft="draft-1"]')!
    await click(button(row, 'Discard'))
    expect(row.querySelector('[role="group"]')?.textContent).toContain('Discard this draft? Nothing is posted.')
    await click(button(row.querySelector('[role="group"]')!, 'Discard'))
    expect(api.decideAssistantDraft).toHaveBeenCalledWith(AGENT, 'draft-1', 'discard')
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
      { status: 'failed', failure: 'the agent is no longer enabled in that conversation' },
      'Couldn’t post: the agent is no longer enabled in that conversation. Nothing was sent.'
    ],
    [
      { status: 'outcome_unknown', failure: 'socket hang up' },
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

  it('labels a proposal, leads with its sentence, and offers approve or deny only', async () => {
    mocks.drafts = [DRAFT, PROPOSAL]
    const host = await mount(true)
    const row = section(host, 'drafts')!.querySelector('[data-assistant-draft="proposal-1"]')!
    expect(row.textContent).toContain('Proposal')
    expect(row.textContent).toContain('I want to rebase PR #12 because it conflicts with main.')
    expect(row.textContent).toContain('Why: The check found a merge conflict.')
    expect(row.textContent).toContain('Rebase PR #12 onto main and push.')
    expect(row.textContent).toContain('Runs in #support')
    expect(row.textContent).toContain('For Ship the release notes')
    expect([...row.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Approve', 'Deny'])
    expect(section(host, 'drafts')!.querySelector('.badge:not([class*="status-info"])')?.textContent).toBe('2')
  })

  it('names a webchat proposal’s approvers as whoever may continue its conversation', async () => {
    mocks.drafts = [
      {
        ...PROPOSAL,
        target: { ...PROPOSAL.target, platform: 'webchat', integrationId: null, channel: 'conv-1', name: null },
        approver: null,
        inConversation: true
      }
    ]
    const host = await mount(true)
    const row = section(host, 'drafts')!.querySelector('[data-assistant-draft="proposal-1"]')!
    expect(row.textContent).toContain('Runs in Webchat')
    expect(row.textContent).toContain('Approver: anyone who may continue the conversation')
    expect(row.textContent).not.toContain('No one reachable')
  })

  it('approves a proposal after a confirmation, and says it runs in the background', async () => {
    mocks.drafts = [PROPOSAL]
    mocks.outcome = { status: 'executing', failure: null }
    const host = await mount(true)
    const row = host.querySelector('[data-assistant-draft="proposal-1"]')!
    await click(button(row, 'Approve'))
    expect(row.querySelector('[role="group"]')?.textContent).toContain('Run this now? It reports back in #support.')
    await click(button(row.querySelector('[role="group"]')!, 'Approve'))
    expect(api.decideAssistantDraft).toHaveBeenCalledWith(AGENT, 'proposal-1', 'approve')
    expect(row.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe(
      'Approved. It runs as a task and reports back in #support.'
    )
    expect(row.querySelector('button')).toBeNull()
  })

  it('denies a proposal after a confirmation, running nothing', async () => {
    mocks.drafts = [PROPOSAL]
    mocks.outcome = { status: 'denied', failure: null }
    const host = await mount(true)
    const row = host.querySelector('[data-assistant-draft="proposal-1"]')!
    await click(button(row, 'Deny'))
    expect(row.querySelector('[role="group"]')?.textContent).toContain('Deny this proposal? Nothing is run.')
    await click(button(row.querySelector('[role="group"]')!, 'Deny'))
    expect(api.decideAssistantDraft).toHaveBeenCalledWith(AGENT, 'proposal-1', 'discard')
    expect(row.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe('Denied. Nothing was run.')
  })

  it('keeps a proposal waiting, with its choices, while the agent runs as many tasks as it may', async () => {
    mocks.drafts = [PROPOSAL]
    const limit = 'bot already has 3 tasks running, the most it runs at once.'
    mocks.decideFailure = new ApiError(limit, 409, 'SUBSESSION_LIMIT')
    const host = await mount(true)
    const row = host.querySelector('[data-assistant-draft="proposal-1"]')!
    await click(button(row, 'Approve'))
    await click(button(row.querySelector('[role="group"]')!, 'Approve'))
    expect(row.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe(limit)
    expect(button(row, 'Approve')).toBeTruthy()
    mocks.decideFailure = null
    mocks.outcome = { status: 'executing', failure: null }
    await click(button(row, 'Approve'))
    await click(button(row.querySelector('[role="group"]')!, 'Approve'))
    expect(row.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe(
      'Approved. It runs as a task and reports back in #support.'
    )
  })

  it('lists tasks waiting for permission and answers them with their own choices', async () => {
    mocks.permissions = [PERMISSION, HIDDEN_PERMISSION]
    const host = await mount(true)
    const drafts = section(host, 'drafts')!
    const waiting = () => drafts.firstElementChild?.querySelector('.badge')?.textContent
    // Two requests and one draft wait.
    expect(waiting()).toBe('3')
    const row = drafts.querySelector('[data-assistant-permission="request-1"]')!
    expect(row.querySelector('.badge')?.textContent).toBe('Permission')
    expect(row.textContent).toContain('Write src/app.ts')
    expect(row.textContent).toContain('Denied and stopped Oct 9, 2026')
    const links = [...row.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])
    expect(links).toEqual([
      ['Fix the flaky test', '/example/sessions/sid-child'],
      ['From #support', '/example/sessions/sid-parent']
    ])
    const labels = (scope: Element) => [...scope.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels(row)).toEqual(['Always allow', 'Allow', 'Deny'])
    const hidden = drafts.querySelector('[data-assistant-permission="request-2"]')!
    expect(hidden.textContent).toContain('Not visible to you')
    expect(hidden.querySelector('a')).toBeNull()
    expect(labels(hidden)).toEqual(['Allow', 'Deny'])

    await click(button(row, 'Always allow'))
    expect(api.decideAgentPermissionRequest).toHaveBeenCalledWith(AGENT, 'request-1', 'allow', 'o-always')
    expect(row.querySelector('[role="status"]')?.textContent).toBe('Allowed. The task continues.')
    expect(row.querySelector('button')).toBeNull()
    expect(waiting()).toBe('2')

    await click(button(hidden, 'Deny'))
    expect(api.decideAgentPermissionRequest).toHaveBeenLastCalledWith(AGENT, 'request-2', 'deny', undefined)
    expect(hidden.querySelector('[role="status"]')?.textContent).toBe('Denied.')
  })

  it('says a request answered elsewhere first is no longer waiting, and reads the list again', async () => {
    mocks.permissions = [PERMISSION]
    mocks.permissionFailure = new ApiError('no longer pending', 409)
    const host = await mount(true)
    const row = host.querySelector('[data-assistant-permission="request-1"]')!
    const reads = api.fetchAssistantDrafts.mock.calls.length
    await click(button(row, 'Allow'))
    expect(row.querySelector('[role="status"]')?.textContent).toBe('No longer waiting for approval.')
    expect(api.fetchAssistantDrafts.mock.calls.length).toBeGreaterThan(reads)
  })

  it('shows only drafts when the console reads no permission requests', async () => {
    const host = await mount(true)
    const drafts = section(host, 'drafts')!
    expect(drafts.querySelector('[data-assistant-permission]')).toBeNull()
    expect(drafts.querySelector('[data-assistant-draft="draft-1"]')).not.toBeNull()
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
})

describe('the Activity view of an agent outside assistant mode', () => {
  const sections = (host: HTMLElement) =>
    [...host.querySelectorAll('[data-activity-section]')].map((s) => s.getAttribute('data-activity-section'))

  it('shows an editor its tasks, permission requests and drafts, and reads no items', async () => {
    mocks.permissions = [PERMISSION]
    const host = await mount(true, false)
    expect(sections(host)).toEqual(['subsessions', 'drafts'])
    expect(api.fetchAssistantItems).not.toHaveBeenCalled()
    expect(host.querySelector('[data-assistant-item]')).toBeNull()
    expect(button(host, 'Done and dropped')).toBeUndefined()

    const subsessions = section(host, 'subsessions')!
    expect(subsessions.querySelector('[data-assistant-subsession="sid-child"]')?.textContent).toContain('Running')
    const drafts = section(host, 'drafts')!
    expect(drafts.firstElementChild?.textContent).toContain('Waiting for approval')
    expect(drafts.querySelector('[data-assistant-permission="request-1"]')?.textContent).toContain('Write src/app.ts')
    expect(drafts.querySelector('[data-assistant-draft="draft-1"]')?.textContent).toContain('The release is out.')

    // Both are decided as an assistant-mode agent’s are.
    await click(button(drafts.querySelector('[data-assistant-permission="request-1"]')!, 'Allow'))
    expect(api.decideAgentPermissionRequest).toHaveBeenCalledWith(AGENT, 'request-1', 'allow', 'o-allow')
    const draft = drafts.querySelector('[data-assistant-draft="draft-1"]')!
    await click(button(draft, 'Approve'))
    await click(button(draft.querySelector('[role="group"]')!, 'Approve'))
    expect(api.decideAssistantDraft).toHaveBeenCalledWith(AGENT, 'draft-1', 'approve')
  })

  it('shows anyone else its tasks alone', async () => {
    const host = await mount(false, false)
    expect(sections(host)).toEqual(['subsessions'])
    expect(api.fetchAssistantItems).not.toHaveBeenCalled()
    expect(api.fetchAssistantDrafts).not.toHaveBeenCalled()
    expect(api.fetchAssistantSubsessions).toHaveBeenCalledWith(AGENT)
  })

  it('keeps one responsive tree on a phone, its colors from the theme’s tokens', async () => {
    mocks.permissions = [PERMISSION]
    const host = await mount(true, false)
    const panel = host.querySelector('[data-assistant-activity]')!
    expect(panel.className).toContain('p-4')
    expect(panel.className).toContain('desktop:p-0')
    const subsession = host.querySelector('[data-assistant-subsession="sid-child"]')!
    expect(subsession.className).toContain('flex-col')
    expect(subsession.className).toContain('desktop:flex-row')
    expect(host.querySelector('[data-assistant-draft-actions]')?.className).toContain('flex-wrap')
    // Every color is a token, so the dark theme's remap applies; no literal would survive it.
    for (const badge of host.querySelectorAll('.badge')) expect(badge.className).toMatch(/(bg|text)-\(--/)
    expect(panel.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })

  it('reads in Chinese with the zh-CN messages', async () => {
    mocks.permissions = [PERMISSION]
    const host = await mount(true, false, (node) => (
      <NextIntlClientProvider locale="zh-CN" messages={chinese} timeZone="UTC">
        {node}
      </NextIntlClientProvider>
    ))
    expect(section(host, 'subsessions')?.firstElementChild?.textContent).toContain('任务')
    expect(section(host, 'subsessions')?.textContent).toContain('运行中')
    expect(section(host, 'drafts')?.firstElementChild?.textContent).toContain('等待批准')
    expect(host.querySelector('[data-assistant-permission="request-1"] .badge')?.textContent).toBe('权限')
  })
})

describe('the Activity view toward a daemon that serves follow-ups', () => {
  const sections = (host: HTMLElement) =>
    [...host.querySelectorAll('[data-activity-section]')].map((s) => s.getAttribute('data-activity-section'))
  const row = (host: HTMLElement, id: string) =>
    section(host, 'subsessions')!.querySelector<HTMLElement>(`[data-assistant-subsession="${id}"]`)!

  beforeEach(() => {
    mocks.followUps = true
    mocks.subsessions = FOLLOW_UPS
  })

  it('shows no Items section and reads no items', async () => {
    const host = await mount(true)
    expect(sections(host)).toEqual(['subsessions', 'drafts'])
    expect(api.fetchAssistantItems).not.toHaveBeenCalled()
    expect(button(host, 'Done and dropped')).toBeUndefined()
  })

  it('names a follow-up taken in a DM by its person, with no channel sigil', async () => {
    const dm = { sessionId: 'sid-dm', title: null, platform: 'slack', channelName: '@Alice' }
    mocks.subsessions = [{ ...FOLLOW_UPS[0]!, parent: dm }]
    const host = await mount(false)
    expect(row(host, 'sid-follow').textContent).toContain('From @Alice')
    expect(row(host, 'sid-follow').textContent).not.toContain('#@')
  })

  it('lists follow-ups with their state, kind and next check, and their checks only where visible', async () => {
    const host = await mount(false)
    const waiting = row(host, 'sid-follow')
    expect(waiting.dataset.followUp).toBe('waiting')
    expect(waiting.querySelector('.badge')?.textContent).toBe('Waiting')
    expect(waiting.textContent).toContain('Follow-up')
    expect(waiting.textContent).toContain('Next check Oct 16, 2026, 9:00 AM')
    expect(waiting.textContent).toContain('From #support')
    expect(waiting.textContent).not.toContain('Started')
    const hidden = row(host, 'hidden')
    expect(hidden.querySelector('.badge')?.textContent).toBe('Paused')
    expect(hidden.textContent).toContain('Not visible to you')
    expect(button(hidden, 'Show checks')).toBeUndefined()
    expect(row(host, 'sid-ended').querySelector('.badge')?.textContent).toBe('Stopped')
    expect(row(host, 'sid-child').textContent).toContain('Running')
    expect(row(host, 'sid-child').textContent).toContain('Started')

    // The viewer may end only the follow-up whose stop rule allows it.
    expect([...host.querySelectorAll('button')].filter((b) => b.textContent === 'End follow-up')).toHaveLength(1)
    expect(button(waiting, 'End follow-up')).toBeTruthy()

    expect(host.querySelector('[data-follow-up-checks]')).toBeNull()
    await click(button(waiting, 'Show checks'))
    const checks = waiting.querySelector('[data-follow-up-checks]')!
    expect(checks.textContent).toContain('Done when: The release is published')
    expect(checks.querySelector('[data-follow-up-check="reported"]')?.textContent).toContain('Still a draft.')
    expect(checks.textContent).toContain('Oct 15, 2026, 9:00 AM')
  })

  it('ends a follow-up after a confirmation, and reads the tasks again', async () => {
    const host = await mount(false)
    const waiting = row(host, 'sid-follow')
    await click(button(waiting, 'End follow-up'))
    expect(api.stopAssistantSubsession).not.toHaveBeenCalled()
    expect(waiting.querySelector('[role="group"]')?.textContent).toContain(
      'End this follow-up? The agent stops checking.'
    )
    const reads = api.fetchAssistantSubsessions.mock.calls.length
    await click(button(waiting.querySelector('[role="group"]')!, 'End follow-up'))
    expect(api.stopAssistantSubsession).toHaveBeenCalledWith(AGENT, 'sid-follow')
    expect(waiting.querySelector('[data-follow-up-end]')?.textContent).toBe('Follow-up ended.')
    expect(waiting.querySelector('[role="group"]')).toBeNull()
    expect(api.fetchAssistantSubsessions.mock.calls.length).toBeGreaterThan(reads)
  })

  it('ends a follow-up whose first check has not run by its own id, under the conversation it is listed in', async () => {
    mocks.subsessions = [
      { ...FOLLOW_UPS[0]!, sessionId: null, followUp: { ...FOLLOW_UPS[0]!.followUp!, id: 'item-9' } },
      // Without an id from its daemon, a follow-up with no session has nothing to end it by.
      { ...FOLLOW_UPS[0]!, sessionId: null, startedAt: '2026-10-09T08:00:00.000Z' }
    ]
    const host = await mount(false)
    const [unchecked] = [...section(host, 'subsessions')!.querySelectorAll<HTMLElement>('[data-assistant-subsession]')]
    expect([...host.querySelectorAll('button')].filter((b) => b.textContent === 'End follow-up')).toHaveLength(1)
    await click(button(unchecked!, 'End follow-up'))
    await click(button(unchecked!.querySelector('[role="group"]')!, 'End follow-up'))
    expect(api.stopAssistantFollowUp).toHaveBeenCalledWith(AGENT, 'item-9', 'sid-parent')
    expect(api.stopAssistantSubsession).not.toHaveBeenCalled()
    expect(unchecked!.querySelector('[data-follow-up-end]')?.textContent).toBe('Follow-up ended.')
  })

  it('keeps the Items section toward a daemon without them, or when the task list cannot say', async () => {
    for (const setup of [
      () => (mocks.followUps = false),
      () => (mocks.subsessionsFailure = new ApiError('offline', 503, 'DAEMON_OFFLINE'))
    ]) {
      api.fetchAssistantItems.mockClear()
      setup()
      const host = await mount(false)
      expect(sections(host)).toEqual(['items', 'subsessions'])
      expect(api.fetchAssistantItems.mock.calls.map((call) => call[1])).toEqual(['open'])
      await act(async () => root?.unmount())
      root = undefined
      container?.remove()
    }
  })

  it('reads in Chinese with the zh-CN messages', async () => {
    const host = await mount(false, true, (node) => (
      <NextIntlClientProvider locale="zh-CN" messages={chinese} timeZone="UTC">
        {node}
      </NextIntlClientProvider>
    ))
    const waiting = row(host, 'sid-follow')
    expect(waiting.querySelector('.badge')?.textContent).toBe('等待中')
    expect(waiting.textContent).toContain('跟进')
    expect(waiting.textContent).toContain('下次检查：')
    expect(button(waiting, '结束跟进')).toBeTruthy()
    expect(button(waiting, '显示检查记录')).toBeTruthy()
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
    await click(button(draft, 'Approve'))
    expect(draft.querySelector('[role="group"]')?.className).toContain('flex-wrap')
  })
})
