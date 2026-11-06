// @vitest-environment happy-dom

// A coordinator's task card in its conversation: its state from the conversation's task rows, its reply count as the daemon counts it, and a click that opens the thread instead of leaving the page.

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

import { TaskThreadCard } from './TaskThreadCard'
import type { AssistantSubsessionDto } from '@/lib/api'
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

describe('TaskThreadCard', () => {
  it('shows the task’s state and its replies, and opens its thread on click', async () => {
    wire.rows = [taskRow({ replies: 3, lastReplyAt: new Date(Date.now() - 60_000).toISOString() })]
    const onOpen = vi.fn()
    await render(<TaskThreadCard agentId="agent_1" link={link} parentSessionId="ses_coordinator" onOpen={onOpen} />)
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
    await render(<TaskThreadCard agentId="agent_1" link={link} parentSessionId="ses_coordinator" onOpen={() => {}} />)
    expect(wire.rowReads).toEqual(['agent_1/ses_task'])
    expect(container.querySelector('[data-state-icon]')?.getAttribute('aria-label')).toBe('Idle')
    expect(container.querySelector('[data-task-card-replies]')?.textContent).toBe('Reply')
  })

  it('links to the task’s page where no thread can open beside the chat, reading the task alone', async () => {
    await render(<TaskThreadCard agentId="agent_1" link={link} parentSessionId={null} />)
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/acme/sessions/ses_task')
    expect(container.querySelector('button')).toBeNull()
    expect(wire.listReads).toEqual([])
    expect(wire.rowReads).toEqual(['agent_1/ses_task'])
  })
})
