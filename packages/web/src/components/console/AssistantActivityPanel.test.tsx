// @vitest-environment happy-dom
// The Activity view: what waits for an editor, the tasks and follow-ups everyone who can view the agent sees, and the finished ones behind one toggle.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantDraftDto, AssistantPermissionRequestDto, AssistantSubsessionDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const AGENT = 'agent-1'
const INTEGRATION = 'int-1'

const mocks = vi.hoisted(() => ({
  subsessions: [] as unknown[],
  subsessionsTruncated: false,
  subsessionsFailure: null as Error | null,
  stopAnswer: { result: 'stopped' } as unknown,
  drafts: [] as unknown[],
  /** Unset: a Control Plane that does not list tasks' permission requests. */
  permissions: undefined as unknown[] | undefined,
  outcome: { status: 'succeeded', failure: null } as unknown,
  decideFailure: null as Error | null,
  permissionFailure: null as Error | null
}))

const api = vi.hoisted(() => ({
  fetchAssistantSubsessions: vi.fn(async (_agentId: string) => {
    if (mocks.subsessionsFailure) throw mocks.subsessionsFailure
    return { subsessions: mocks.subsessions, truncated: mocks.subsessionsTruncated, nextCursor: null }
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

const SUPPORT = { sessionId: 'sid-parent', title: 'support', platform: 'slack', channelName: 'support' }

/** A running task the viewer may open and stop, and a failed one it may not see. */
const TASK: AssistantSubsessionDto = {
  sessionId: 'sid-child',
  title: 'Fix the flaky test',
  state: 'open',
  startedAt: '2026-10-09T09:00:00.000Z',
  visible: true,
  canStop: true,
  parent: SUPPORT,
  kind: 'delegated'
}
const HIDDEN_FAILED: AssistantSubsessionDto = {
  sessionId: null,
  title: null,
  state: 'failed',
  startedAt: '2026-10-09T08:00:00.000Z',
  visible: false,
  canStop: false,
  parent: null,
  kind: 'delegated'
}
/** A follow-up the viewer may see and end, a hidden one, and an ended one. */
const FOLLOW_UP: AssistantSubsessionDto = {
  sessionId: 'sid-follow',
  title: 'Watch the release',
  state: 'open',
  startedAt: '2026-10-09T09:00:00.000Z',
  visible: true,
  canStop: true,
  parent: SUPPORT,
  kind: 'follow-up',
  followUp: {
    status: 'waiting',
    nextCheck: '2026-10-16T09:00:00.000Z',
    doneWhen: 'The release is published',
    recentChecks: [{ at: '2026-10-15T09:00:00.000Z', observation: 'Still a draft.', reported: true }]
  }
}
const HIDDEN_FOLLOW_UP: AssistantSubsessionDto = {
  sessionId: null,
  title: null,
  state: 'open',
  startedAt: '2026-10-08T09:00:00.000Z',
  visible: false,
  canStop: false,
  parent: null,
  kind: 'follow-up',
  followUp: { status: 'paused', nextCheck: null, doneWhen: null, recentChecks: [] }
}
const ENDED: AssistantSubsessionDto = {
  sessionId: 'sid-ended',
  title: 'Rotate the key',
  state: 'done',
  startedAt: '2026-10-07T09:00:00.000Z',
  visible: true,
  canStop: false,
  parent: null,
  kind: 'follow-up',
  followUp: { status: 'stopped', nextCheck: null, doneWhen: 'The key is rotated', recentChecks: [] }
}
const ROWS = [FOLLOW_UP, HIDDEN_FOLLOW_UP, ENDED, TASK, HIDDEN_FAILED]

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
/** A first look's follow-up form: approving takes this follow-up instead of running a task (assistant-mode.md §5.13). */
const FOLLOW_UP_FORM: AssistantDraftDto = {
  ...PROPOSAL,
  id: 'proposal-2',
  text: 'The 2.6 release date',
  proposal: {
    sentence: 'I want to follow up the 2.6 release date because Ada is waiting on it.',
    why: 'Ada asked for a date on Monday.',
    itemId: 'item-look',
    itemTitle: 'First look at support',
    followUp: { title: 'The 2.6 release date', doneWhen: 'A date is posted.', nextCheck: '2026-10-20T01:00:00.000Z' }
  }
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
  parent: SUPPORT
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
  // Four minutes into the first task, on the day the permission request expires.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-09T09:04:00.000Z') })
  for (const fn of Object.values(api)) fn.mockClear()
  mocks.subsessions = ROWS
  mocks.subsessionsTruncated = false
  mocks.subsessionsFailure = null
  mocks.stopAnswer = { result: 'stopped' }
  mocks.drafts = [DRAFT]
  mocks.permissions = undefined
  mocks.outcome = { status: 'succeeded', failure: null }
  mocks.decideFailure = null
  mocks.permissionFailure = null
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.useRealTimers()
})

async function mount(canEdit: boolean, wrap: (node: ReactNode) => ReactNode = (node) => node) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      wrap(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <AssistantActivityPanel agentId={AGENT} canEdit={canEdit} />
        </SWRConfig>
      )
    )
  })
  await act(async () => {})
  return container
}

const group = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-task-group="${id}"]`)
const groups = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('[data-task-group]')].map((g) => g.dataset.taskGroup)
const count = (host: HTMLElement, id: string) => group(host, id)?.querySelector('[data-task-group-count]')?.textContent
const taskRow = (host: HTMLElement, sessionId: string) =>
  [...host.querySelectorAll<HTMLElement>('[data-subsession-row]')].find(
    (row) => row.querySelector('a')?.getAttribute('href') === `/example/sessions/${sessionId}`
  )!
const meta = (row: Element) => row.querySelector('[data-meta-line]')?.textContent
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy()
  await act(async () => (element as HTMLElement).click())
  await act(async () => {})
}
const button = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label
  )
/** The row's decision and stop buttons, not its links or preview line. */
const actions = (row: Element) => [...row.querySelectorAll('.dsbtn')].map((b) => b.textContent?.trim())

describe('the Activity view for anyone who can view the agent', () => {
  it('groups tasks and follow-ups with their place, and reads nothing an editor alone sees', async () => {
    const host = await mount(false)
    expect(groups(host)).toEqual(['tasks', 'follow-ups'])
    expect(count(host, 'tasks')).toBe('1')
    expect(count(host, 'follow-ups')).toBe('2')
    expect(host.textContent).not.toContain('Waiting for you')
    expect(api.fetchAssistantDrafts).not.toHaveBeenCalled()

    const task = taskRow(host, 'sid-child')
    // The platform's mark leads the place, and nothing reads "From".
    expect(meta(task)).toBe('#support · Running · started 4m ago')
    expect(task.querySelector('[data-state-mark]')?.getAttribute('data-state-mark')).toBe('running')
    const links = [...task.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])
    expect(links).toEqual([
      ['Fix the flaky test', '/example/sessions/sid-child'],
      ['#support', '/example/sessions/sid-parent']
    ])
    expect(task.textContent).not.toContain('From')
    expect(actions(task)).toEqual(['Stop'])
  })

  it('keeps finished rows behind one toggle, then shows them dimmed in their groups', async () => {
    const host = await mount(false)
    const toggle = host.querySelector('[data-finished-toggle]')!
    expect(toggle.textContent).toBe('2 finished')
    expect(host.textContent).not.toContain('Rotate the key')
    await click(toggle)
    expect(count(host, 'tasks')).toBe('2')
    expect(count(host, 'follow-ups')).toBe('3')
    const ended = taskRow(host, 'sid-ended')
    expect(ended.className).toContain('opacity-60')
    expect(meta(ended)).toBe('Stopped')
    const hidden = group(host, 'tasks')!.querySelectorAll<HTMLElement>('[data-subsession-row]')[1]!
    expect(hidden.textContent).toContain('Not visible to you')
    expect(hidden.querySelector('a')).toBeNull()
    expect(meta(hidden)).toMatch(/^Failed · started /)
  })

  it('stops a running task and reads the list again', async () => {
    const host = await mount(false)
    const reads = api.fetchAssistantSubsessions.mock.calls.length
    await click(button(taskRow(host, 'sid-child'), 'Stop'))
    expect(api.stopAssistantSubsession).toHaveBeenCalledWith(AGENT, 'sid-child')
    expect(taskRow(host, 'sid-child').querySelector('[data-subsession-stop]')?.textContent).toBe('Stopped.')
    expect(api.fetchAssistantSubsessions.mock.calls.length).toBeGreaterThan(reads)
  })

  it('says when the agent’s daemon is too old to answer', async () => {
    mocks.subsessionsFailure = new ApiError('upgrade', 409, 'DAEMON_FEATURE_MISSING')
    const host = await mount(false)
    expect(host.textContent).toBe('Upgrade this agent’s daemon to see its activity.')
  })

  it('says so once when nothing runs or waits', async () => {
    mocks.subsessions = []
    mocks.drafts = []
    const host = await mount(true)
    expect(groups(host)).toEqual([])
    expect(host.textContent).toBe('Nothing running or waiting.')
  })

  it('notes a truncated list with the finished rows', async () => {
    mocks.subsessionsTruncated = true
    const host = await mount(false)
    expect(host.textContent).not.toContain('Only the most recent are shown.')
    await click(host.querySelector('[data-finished-toggle]'))
    expect(host.textContent).toContain('Only the most recent are shown.')
  })
})

describe('follow-ups in Activity', () => {
  it('shows the place and next check in the meta line, and its checks under its done-when line', async () => {
    const host = await mount(false)
    const row = taskRow(host, 'sid-follow')
    expect(row.dataset.followUp).toBe('waiting')
    expect(row.querySelector('[data-state-mark]')?.getAttribute('data-state-mark')).toBe('open')
    expect(meta(row)).toBe('#support · Next check Oct 16, 9:00 AM · last Oct 15, 9:00 AM')
    const line = row.querySelector('[data-preview-line]')!
    // The sentence alone, quieter than a message's preview.
    expect(line.textContent).toBe('The release is published')
    expect(line.className).toContain('text-(--text-tertiary)')
    expect(line.getAttribute('aria-expanded')).toBe('false')
    expect(row.querySelector('[data-follow-up-checks]')).toBeNull()
    await click(line)
    const checks = row.querySelector('[data-follow-up-checks]')!
    // The done-when line is already on screen, so the checks do not repeat it.
    expect(checks.textContent).not.toContain('The release is published')
    expect(checks.querySelector('[data-follow-up-check="reported"]')?.textContent).toContain('Still a draft.')

    const hidden = group(host, 'follow-ups')!.querySelectorAll<HTMLElement>('[data-subsession-row]')[1]!
    expect(hidden.querySelector('[data-state-mark]')?.getAttribute('data-state-mark')).toBe('paused')
    expect(hidden.textContent).toContain('Not visible to you')
    expect(hidden.querySelector('[data-preview-line]')).toBeNull()
    expect(actions(hidden)).toEqual([])
  })

  it('names a follow-up taken in a DM by its person, with no channel sigil', async () => {
    mocks.subsessions = [{ ...FOLLOW_UP, parent: { ...SUPPORT, sessionId: 'sid-dm', channelName: '@Alice' } }]
    const host = await mount(false)
    expect(meta(taskRow(host, 'sid-follow'))).toMatch(/^@Alice · /)
  })

  it('never presents the conversation’s title as its place, keeping the mark and a neutral label', async () => {
    mocks.subsessions = [{ ...FOLLOW_UP, parent: { ...SUPPORT, title: 'Planning the 2.6 release', channelName: null } }]
    const host = await mount(false)
    const line = taskRow(host, 'sid-follow').querySelector('[data-meta-line]')!
    expect(meta(taskRow(host, 'sid-follow'))).toMatch(/^Conversation · /)
    expect(line.textContent).not.toContain('Planning the 2.6 release')
    // The platform's mark still leads the line.
    expect(line.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
  })

  // assistant-mode.md §5.13: a first look is a follow-up row labelled as one.
  it('labels a first look as one', async () => {
    mocks.subsessions = [{ ...FOLLOW_UP, followUp: { ...FOLLOW_UP.followUp!, firstLook: true, nextCheck: null } }]
    const host = await mount(false)
    expect(meta(taskRow(host, 'sid-follow'))).toBe('#support · First look · Waiting · last Oct 15, 9:00 AM')
  })

  // Its place's long session opens only once it reports, so while it runs its own session names the place.
  it('names a running first look’s place from its own session, then by its conversation once it reports', async () => {
    const look: AssistantSubsessionDto = {
      ...FOLLOW_UP,
      title: 'First look at release',
      followUp: { ...FOLLOW_UP.followUp!, status: 'checking', nextCheck: null, recentChecks: [], firstLook: true }
    }
    mocks.subsessions = [{ ...look, parent: null, place: { platform: 'slack', channelName: 'release' } }]
    const running = await mount(false)
    const line = taskRow(running, 'sid-follow').querySelector('[data-meta-line]')!
    expect(meta(taskRow(running, 'sid-follow'))).toBe('#release · First look · Checking')
    expect(line.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    // No conversation to open yet, so the place is not a link.
    expect(line.querySelector('[data-task-place]')).not.toBeNull()
    expect(line.querySelector('a')).toBeNull()

    await act(async () => root?.unmount())
    running.remove()
    mocks.subsessions = [{ ...look, parent: { ...SUPPORT, sessionId: 'sid-place', channelName: 'release' } }]
    const reported = await mount(false)
    const link = taskRow(reported, 'sid-follow').querySelector<HTMLAnchorElement>('[data-meta-line] a')!
    expect(meta(taskRow(reported, 'sid-follow'))).toBe('#release · First look · Checking')
    expect(link.getAttribute('href')).toContain('/sessions/sid-place')
  })

  it('never names a running first look’s place by its title when its channel has no name', async () => {
    mocks.subsessions = [
      {
        ...FOLLOW_UP,
        title: 'First look at release',
        parent: null,
        place: { platform: 'slack', channelName: null },
        followUp: { ...FOLLOW_UP.followUp!, status: 'checking', nextCheck: null, recentChecks: [], firstLook: true }
      }
    ]
    const host = await mount(false)
    expect(meta(taskRow(host, 'sid-follow'))).toBe('Conversation · First look · Checking')
  })

  it('ends a follow-up after a confirmation, and reads the tasks again', async () => {
    const host = await mount(false)
    const row = taskRow(host, 'sid-follow')
    await click(button(row, 'End'))
    expect(api.stopAssistantSubsession).not.toHaveBeenCalled()
    expect(row.querySelector('[role="group"]')?.textContent).toContain('End this follow-up? The agent stops checking.')
    const reads = api.fetchAssistantSubsessions.mock.calls.length
    await click(button(row.querySelector('[role="group"]')!, 'End follow-up'))
    expect(api.stopAssistantSubsession).toHaveBeenCalledWith(AGENT, 'sid-follow')
    expect(row.querySelector('[data-subsession-stop]')?.textContent).toBe('Follow-up ended.')
    expect(row.querySelector('[role="group"]')).toBeNull()
    expect(api.fetchAssistantSubsessions.mock.calls.length).toBeGreaterThan(reads)
  })

  it('ends a follow-up whose first check has not run by its own id, under the conversation it is listed in', async () => {
    mocks.subsessions = [
      { ...FOLLOW_UP, sessionId: null, followUp: { ...FOLLOW_UP.followUp!, id: 'item-9' } },
      // Without an id from its daemon, a follow-up with no session has nothing to end it by.
      { ...FOLLOW_UP, sessionId: null, startedAt: '2026-10-09T08:00:00.000Z' }
    ]
    const host = await mount(false)
    const [unchecked, other] = [...host.querySelectorAll<HTMLElement>('[data-subsession-row]')]
    expect(actions(unchecked!)).toEqual(['End'])
    expect(actions(other!)).toEqual([])
    await click(button(unchecked!, 'End'))
    await click(button(unchecked!.querySelector('[role="group"]')!, 'End follow-up'))
    expect(api.stopAssistantFollowUp).toHaveBeenCalledWith(AGENT, 'item-9', 'sid-parent')
    expect(api.stopAssistantSubsession).not.toHaveBeenCalled()
    expect(unchecked!.querySelector('[data-subsession-stop]')?.textContent).toBe('Follow-up ended.')
  })
})

describe('Waiting for you', () => {
  it('leads with drafts, then proposals, then permission requests, each with its kind word and an amber mark', async () => {
    mocks.drafts = [PROPOSAL, DRAFT]
    mocks.permissions = [PERMISSION]
    const host = await mount(true)
    expect(groups(host)).toEqual(['waiting', 'tasks', 'follow-ups'])
    const waiting = group(host, 'waiting')!
    expect(waiting.querySelector('h3')?.textContent).toBe('Waiting for you3')
    const rows = [...waiting.querySelectorAll<HTMLElement>('[data-assistant-draft], [data-assistant-permission]')]
    expect(rows.map((row) => row.dataset.assistantDraft ?? row.dataset.assistantPermission)).toEqual([
      'draft-1',
      'proposal-1',
      'request-1'
    ])
    for (const row of rows)
      expect(row.querySelector('[data-state-mark]')?.getAttribute('data-state-mark')).toBe('waiting')
  })

  it('names a draft’s target in its title alone, with its approver and expiry in the meta line', async () => {
    mocks.drafts = [DRAFT, REPLY]
    const host = await mount(true)
    const draft = host.querySelector('[data-assistant-draft="draft-1"]')!
    expect(draft.textContent).toContain('Message to #support · in a thread')
    expect(meta(draft)).toBe('Draft · Ada approves · expires Oct 10, 9:00 AM')
    expect(draft.querySelector('[data-meta-line] svg, [data-meta-line] img')).not.toBeNull()
    const line = draft.querySelector('[data-preview-line]')!
    expect(line.textContent).toBe('The release is out.\n\nNotes are in the docs.')
    expect(line.querySelector('span')?.className).toContain('truncate')
    await click(line)
    expect(line.querySelector('span')?.className).toContain('whitespace-pre-wrap')
    expect(actions(draft)).toEqual(['Discard', 'Approve'])
    const reply = host.querySelector('[data-assistant-draft="draft-2"]')!
    expect(reply.textContent).toContain('External')
    expect(actions(reply)).toEqual(['Discard', 'Approve'])
  })

  it('approves a draft after a confirmation, then shows the outcome in place of the choices', async () => {
    const host = await mount(true)
    const draft = host.querySelector('[data-assistant-draft="draft-1"]')!
    await click(button(draft, 'Approve'))
    expect(api.decideAssistantDraft).not.toHaveBeenCalled()
    const confirm = draft.querySelector('[role="group"]')!
    expect(confirm.textContent).toContain('Post this to #support now?')
    expect(actions(draft)).toEqual(['Approve', 'Cancel'])
    await click(button(confirm, 'Approve'))
    expect(api.decideAssistantDraft).toHaveBeenCalledWith(AGENT, 'draft-1', 'approve')
    expect(draft.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe('Posted.')
    expect(actions(draft)).toEqual([])
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
    expect(actions(draft)).toEqual([])
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
    expect(row.textContent).toContain('Message to #support')
    expect(row.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe(
      'Couldn’t confirm the decision, and it is no longer waiting. Check the destination; it may have been posted.'
    )
    expect(actions(row)).toEqual([])
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
    // The count is the rows on screen, decided ones included.
    expect(count(host, 'waiting')).toBe('2')
  })

  it('leads a proposal with its sentence, its reason as the collapsed line, and approve or deny only', async () => {
    mocks.drafts = [PROPOSAL]
    const host = await mount(true)
    const row = host.querySelector('[data-assistant-draft="proposal-1"]')!
    expect(row.textContent).toContain('I want to rebase PR #12 because it conflicts with main.')
    expect(meta(row)).toBe('#support · Suggested task · expires Oct 10, 9:00 AM')
    const line = row.querySelector('[data-preview-line]')!
    expect(line.textContent).toBe('The check found a merge conflict.')
    expect(row.textContent).not.toContain('Rebase PR #12 onto main and push.')
    await click(line)
    expect(row.textContent).toContain('For Ship the release notes')
    expect(row.textContent).toContain('Rebase PR #12 onto main and push.')
    expect(actions(row)).toEqual(['Deny', 'Approve'])
  })

  it('places a webchat proposal under its webchat mark', async () => {
    mocks.drafts = [
      {
        ...PROPOSAL,
        target: { ...PROPOSAL.target, platform: 'webchat', integrationId: null, channel: 'conv-1', name: null },
        approver: null,
        inConversation: true
      }
    ]
    const host = await mount(true)
    const row = host.querySelector('[data-assistant-draft="proposal-1"]')!
    expect(meta(row)).toBe('Webchat · Suggested task · expires Oct 10, 9:00 AM')
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
    expect(actions(row)).toEqual([])
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

  it('shows a follow-up form as what it would take, and once approved links to its conversation', async () => {
    mocks.drafts = [FOLLOW_UP_FORM]
    mocks.outcome = {
      status: 'succeeded',
      failure: null,
      followUp: { id: 'item-taken', conversation: { ...SUPPORT, sessionId: 'sid-support' } }
    }
    const host = await mount(true)
    const row = host.querySelector('[data-assistant-draft="proposal-2"]')!
    expect(meta(row)).toBe('#support · Suggested follow-up · expires Oct 10, 9:00 AM')
    expect(row.querySelector('[data-proposed-follow-up]')).toBeNull()
    await click(row.querySelector('[data-preview-line]'))
    const proposed = row.querySelector('[data-proposed-follow-up]')!
    expect(proposed.textContent).toContain('Takes this follow-up')
    expect(proposed.textContent).toContain('The 2.6 release date')
    expect(proposed.textContent).toContain('A date is posted.')
    expect(proposed.textContent).not.toContain('Done when')
    expect(proposed.textContent).toContain('First check')
    await click(button(row, 'Approve'))
    expect(row.querySelector('[role="group"]')?.textContent).toContain(
      'Take this follow-up in #support? It is followed up for you, and nothing else runs.'
    )
    await click(button(row.querySelector('[role="group"]')!, 'Approve'))
    const outcome = row.querySelector('[data-assistant-draft-outcome]')!
    expect(outcome.textContent).toContain('Approved. The follow-up was taken; it reports back in #support.')
    expect(outcome.querySelector('a')?.getAttribute('href')).toBe('/example/sessions/sid-support')
    expect(outcome.querySelector('a')?.textContent).toBe('See it in its conversation’s Tasks')
  })

  it('names no conversation for a taken follow-up the viewer may not open', async () => {
    mocks.drafts = [FOLLOW_UP_FORM]
    mocks.outcome = { status: 'succeeded', failure: null, followUp: { id: 'item-taken', conversation: null } }
    const host = await mount(true)
    const row = host.querySelector('[data-assistant-draft="proposal-2"]')!
    await click(button(row, 'Approve'))
    await click(button(row.querySelector('[role="group"]')!, 'Approve'))
    const outcome = row.querySelector('[data-assistant-draft-outcome]')!
    expect(outcome.textContent).toBe('Approved. The follow-up was taken; it reports back in #support.')
    expect(outcome.querySelector('a')).toBeNull()
  })

  it('says why a follow-up form’s follow-up was not taken', async () => {
    mocks.drafts = [FOLLOW_UP_FORM]
    mocks.outcome = { status: 'failed', failure: 'its follow-up is gone' }
    const host = await mount(true)
    const row = host.querySelector('[data-assistant-draft="proposal-2"]')!
    await click(button(row, 'Approve'))
    await click(button(row.querySelector('[role="group"]')!, 'Approve'))
    expect(row.querySelector('[data-assistant-draft-outcome]')?.textContent).toBe(
      'Couldn’t take the follow-up: its follow-up is gone.'
    )
  })

  it('lists tasks waiting for permission and answers them with their own choices, denials first', async () => {
    mocks.permissions = [PERMISSION, HIDDEN_PERMISSION]
    const host = await mount(true)
    expect(count(host, 'waiting')).toBe('3')
    const row = host.querySelector('[data-assistant-permission="request-1"]')!
    expect(meta(row)).toBe('#support · Permission · expires 9:00 PM')
    expect(row.querySelector('[data-preview-line]')?.textContent).toBe('Write src/app.ts')
    const links = [...row.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])
    expect(links).toEqual([
      ['Fix the flaky test', '/example/sessions/sid-child'],
      ['#support', '/example/sessions/sid-parent']
    ])
    expect(actions(row)).toEqual(['Deny', 'Always allow', 'Allow'])
    const hidden = host.querySelector('[data-assistant-permission="request-2"]')!
    expect(hidden.textContent).toContain('Not visible to you')
    expect(hidden.querySelector('a')).toBeNull()
    expect(meta(hidden)).toBe('Permission · expires 9:00 PM')
    expect(actions(hidden)).toEqual(['Deny', 'Allow'])

    await click(button(row, 'Always allow'))
    expect(api.decideAgentPermissionRequest).toHaveBeenCalledWith(AGENT, 'request-1', 'allow', 'o-always')
    expect(row.querySelector('[role="status"]')?.textContent).toBe('Allowed. The task continues.')
    expect(actions(row)).toEqual([])

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
})

describe('the Activity view on a phone and in Chinese', () => {
  it('keeps one responsive tree: decisions inline at a 44px tap size, stops always visible, colors from tokens', async () => {
    mocks.permissions = [PERMISSION]
    const host = await mount(true)
    const panel = host.querySelector<HTMLElement>('[data-assistant-activity]')!
    expect(panel.className).toContain('p-4')
    expect(panel.className).toContain('desktop:p-0')
    for (const choice of host.querySelectorAll('[data-task-group="waiting"] .dsbtn'))
      expect(choice.className).toContain('max-desktop:h-11')
    // A stop shows on hover on desktop and always on a phone.
    const stop = button(taskRow(host, 'sid-child'), 'Stop')!
    expect(stop.className).toContain('desktop:opacity-0')
    expect(stop.className).toContain('max-desktop:h-11')
    // Every color but a platform's own mark is a token, so the dark theme's remap applies.
    const copy = panel.cloneNode(true) as HTMLElement
    for (const mark of copy.querySelectorAll('svg, img')) mark.remove()
    expect(copy.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })

  it('reads in Chinese with the zh-CN messages', async () => {
    mocks.permissions = [PERMISSION]
    mocks.drafts = [DRAFT, PROPOSAL]
    const host = await mount(true, (node) => (
      <NextIntlClientProvider locale="zh-CN" messages={chinese} timeZone="UTC">
        {node}
      </NextIntlClientProvider>
    ))
    expect([...host.querySelectorAll('h3')].map((h) => h.firstChild?.textContent)).toEqual(['等你处理', '任务', '跟进'])
    expect(meta(host.querySelector('[data-assistant-draft="draft-1"]')!)).toMatch(/^草稿 · 由 Ada 审批 · /)
    expect(meta(host.querySelector('[data-assistant-draft="proposal-1"]')!)).toMatch(/^#support · 建议的任务 · /)
    expect(meta(host.querySelector('[data-assistant-permission="request-1"]')!)).toMatch(/^#support · 权限 · /)
    expect(meta(taskRow(host, 'sid-child'))).toMatch(/^#support · 运行中 · /)
    expect(meta(taskRow(host, 'sid-follow'))).toContain('下次检查：')
    expect(button(taskRow(host, 'sid-follow'), '结束')).toBeTruthy()
    expect(host.querySelector('[data-finished-toggle]')?.textContent).toBe('2 个已结束')
  })
})
