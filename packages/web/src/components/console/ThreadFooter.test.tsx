// @vitest-environment happy-dom

// A thread's footer: from its summary (count, repliers, preview, holding task, running, unreadable) and, for a task's card, from the task's row.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({
  rows: [] as unknown[],
  listReads: [] as string[],
  rowReads: [] as string[]
}))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  fetchAssistantSubsessions: vi.fn((agentId: string, opts: { parentSessionId?: string }) => {
    wire.listReads.push(`${agentId}/${opts.parentSessionId}`)
    return Promise.resolve({ subsessions: wire.rows, truncated: false, nextCursor: null })
  }),
  fetchAssistantSubsession: vi.fn((agentId: string, sessionId: string) => {
    wire.rowReads.push(`${agentId}/${sessionId}`)
    return Promise.resolve(taskRow({ state: 'done', threaded: true }))
  })
}))

vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...rest}>{children}</a>
  )
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))

import { footerOfSummary, TaskThreadFooter, ThreadFooter } from './ThreadFooter'
import type { AssistantSubsessionDto, SessionThreadSummaryDto } from '@/lib/api'
import { renderWithIntl } from '@/i18n/test-utils'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function taskRow(over: Partial<AssistantSubsessionDto> = {}): AssistantSubsessionDto {
  return {
    sessionId: 'ses_task',
    title: 'Find what blocks api 1.5',
    state: 'open',
    startedAt: new Date().toISOString(),
    visible: true,
    canStop: true,
    parent: null,
    threaded: true,
    ...over
  }
}

const link = { title: 'Find what blocks api 1.5', sessionId: 'ses_task', how: 'opened' as const }
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  wire.rows = []
  wire.listReads = []
  wire.rowReads = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(
      renderWithIntl(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>)
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('TaskThreadFooter', () => {
  it('shows the task’s state and its replies, and opens its thread on click', async () => {
    wire.rows = [taskRow({ replies: 3, lastReplyAt: new Date(Date.now() - 60_000).toISOString() })]
    const onOpen = vi.fn()
    await render(<TaskThreadFooter agentId="agent_1" link={link} parentSessionId="ses_coordinator" onOpen={onOpen} />)
    const card = container.querySelector('[data-task-card="ses_task"]')!
    expect(card.textContent).toContain('Find what blocks api 1.5')
    expect(card.querySelector('[data-state-icon]')?.getAttribute('aria-label')).toBe('Running')
    const replies = card.querySelector<HTMLElement>('[data-task-card-replies]')!
    expect(replies.textContent).toBe('3 replies · 1m')
    expect(replies.title).toBe('3 replies, last reply 1m ago')
    expect(card.querySelectorAll('a')).toHaveLength(1)
    expect(wire.listReads).toEqual(['agent_1/ses_coordinator'])
    expect(wire.rowReads).toEqual([])

    // A plain click anywhere on the card, its reply count included, opens the thread beside the chat.
    const face = card.querySelector<HTMLAnchorElement>('a')!
    expect(face.getAttribute('href')).toBe('/acme/sessions/ses_task')
    act(() => face.click())
    act(() => replies.click())
    expect(onOpen).toHaveBeenCalledTimes(2)
    // A modified click keeps the link's own behaviour: the task's page, in a new tab.
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })
    act(() => {
      face.dispatchEvent(modified)
    })
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(modified.defaultPrevented).toBe(false)
  })

  it('reads its own row when the conversation’s list does not carry it, and says Idle between turns', async () => {
    await render(<TaskThreadFooter agentId="agent_1" link={link} parentSessionId="ses_coordinator" onOpen={() => {}} />)
    expect(wire.rowReads).toEqual(['agent_1/ses_task'])
    expect(container.querySelector('[data-state-icon]')?.getAttribute('aria-label')).toBe('Idle')
    expect(container.querySelector('[data-task-card-replies]')?.textContent).toBe('Reply')
  })

  it('links to the task’s page where no thread can open beside the chat, reading the task alone', async () => {
    await render(<TaskThreadFooter agentId="agent_1" link={link} parentSessionId={null} />)
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/acme/sessions/ses_task')
    expect(container.querySelector('button')).toBeNull()
    expect(wire.listReads).toEqual([])
    expect(wire.rowReads).toEqual(['agent_1/ses_task'])
  })
})

function summary(over: Partial<SessionThreadSummaryDto> = {}): SessionThreadSummaryDto {
  return {
    rootId: 'post-root',
    rootExcerpt: 'Why is the deploy slow?',
    replies: 2,
    lastReplyAt: new Date(Date.now() - 120_000).toISOString(),
    lastReply: { sender: 'user_dana', senderName: 'Dana Reyes', excerpt: 'Still slow after the cache fix' },
    participants: [
      { sender: 'user_dana', senderName: 'Dana Reyes' },
      { sender: 'agent_1', senderName: 'deploy-bot' }
    ],
    readable: true,
    ...over
  }
}

describe('ThreadFooter', () => {
  it('draws an unowned thread as its replies line: repliers, count, last reply and preview, opening the thread', async () => {
    const onOpen = vi.fn()
    await render(<ThreadFooter footer={footerOfSummary(summary())} rootId="post-root" onOpen={onOpen} />)
    const footer = container.querySelector('[data-thread-footer="post-root"]')!
    expect(footer.querySelector('[data-task-card]')).toBeNull()
    expect(footer.querySelector('[data-state-icon]')).toBeNull()
    const marks = [...footer.querySelectorAll('[data-thread-participant]')]
    expect(marks.map((m) => [m.getAttribute('title'), m.textContent])).toEqual([
      ['Dana Reyes', 'DR'],
      ['deploy-bot', 'D']
    ])
    const count = footer.querySelector<HTMLElement>('[title="2 replies, last reply 2m ago"]')!
    expect(count.textContent).toBe('2 replies · 2m')
    expect(footer.querySelector('[data-thread-preview]')?.textContent).toBe(
      'Dana Reyes: Still slow after the cache fix'
    )
    expect(footer.querySelector('[data-thread-working]')).toBeNull()
    // No task, so no page to link: a button opens the thread.
    expect(footer.querySelector('a')).toBeNull()
    const line = footer.querySelector<HTMLButtonElement>('button[data-task-card-replies]')!
    expect(line.getAttribute('aria-label')).toBe('Open the thread')
    act(() => line.click())
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('draws a held thread with its task’s card and says it is working while a turn runs', async () => {
    const held = summary({ task: { sessionId: 'ses_task', title: 'Profile the deploy', state: 'open' }, running: true })
    await render(<ThreadFooter footer={footerOfSummary(held)} rootId="post-root" href="/acme/sessions/ses_task" />)
    const footer = container.querySelector('[data-thread-footer="post-root"]')!
    expect(footer.getAttribute('data-task-card')).toBe('ses_task')
    expect(footer.textContent).toContain('Profile the deploy')
    expect(footer.querySelector('[data-state-icon]')?.getAttribute('data-state-icon')).toBe('running')
    expect(footer.querySelector('[data-thread-working]')?.textContent).toBe('working…')
    expect(footer.querySelector('a')?.getAttribute('href')).toBe('/acme/sessions/ses_task')

    // Between turns a held thread's task rests, as a threaded task does; a failed one says so.
    expect(footerOfSummary({ ...held, running: false }).task).toMatchObject({ tone: 'idle', stateKey: 'state.idle' })
    expect(footerOfSummary({ ...held, running: false, task: { state: 'failed' } }).task).toMatchObject({
      tone: 'failed',
      stateKey: 'state.failed',
      title: 'Why is the deploy slow?'
    })
  })

  it('keeps an unreadable thread to its count and repliers, and opens nothing', async () => {
    const hidden = summary({
      rootExcerpt: undefined,
      lastReply: { sender: 'user_dana', senderName: 'Dana Reyes' },
      task: { sessionId: 'ses_task', state: 'done' },
      readable: false
    })
    const onOpen = vi.fn()
    await render(
      <ThreadFooter
        footer={footerOfSummary(hidden)}
        rootId="post-root"
        href="/acme/sessions/ses_task"
        onOpen={onOpen}
      />
    )
    const footer = container.querySelector('[data-thread-footer="post-root"]')!
    expect(footer.hasAttribute('data-thread-unreadable')).toBe(true)
    expect(footer.textContent).toContain('A task you can’t open')
    expect(footer.textContent).toContain('2 replies')
    expect(footer.querySelectorAll('[data-thread-participant]')).toHaveLength(2)
    expect(footer.querySelector('[data-thread-preview]')).toBeNull()
    expect(footer.querySelector('a, button')).toBeNull()
  })
})
