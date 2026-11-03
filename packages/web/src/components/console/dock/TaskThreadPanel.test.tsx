// @vitest-environment happy-dom

// A coordinator task's thread in the dock: it draws the task's messages and what this visit streams, sends a reply onto the task's own session, and stays read-only where the server says this reader may not continue it.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionStep } from '@/lib/data'

const taskRow = vi.hoisted(() => ({
  sessionId: 'ses_task',
  title: 'Find what blocks api 1.5',
  state: 'open' as const,
  startedAt: '2026-11-03T09:00:00.000Z',
  visible: true,
  canStop: true,
  parent: null,
  threaded: true,
  summary: 'In progress: 3 of 5 release PRs are clear.'
}))

const wire = vi.hoisted(() => ({
  canContinue: true as boolean | null,
  drafts: {} as Record<string, string>,
  live: [] as SessionStep[],
  calls: [] as string[]
}))

vi.mock(import('@/lib/api'), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchAssistantSubsessions: vi.fn(() =>
    Promise.resolve({ subsessions: [taskRow], truncated: false, nextCursor: null })
  ),
  fetchAssistantSubsession: vi.fn(),
  fetchSessionDetail: vi.fn(() => Promise.resolve({ id: 'ses_task', canContinue: wire.canContinue } as never)),
  fetchSessionMessages: vi.fn(() =>
    Promise.resolve({
      sessionId: 'ses_task',
      messages: [
        {
          seq: 1,
          sender: 'user_dana',
          senderName: 'Dana Reyes',
          ts: '2026-11-03T09:00:00.000Z',
          kind: 'text',
          text: 'find what blocks api 1.5'
        },
        { seq: 2, sender: 'agent_1', ts: '2026-11-03T09:01:00.000Z', kind: 'tool', text: 'gh pr list' },
        { seq: 3, sender: 'agent_1', ts: '2026-11-03T09:02:00.000Z', kind: 'text', text: 'Three of five are clear.' }
      ],
      nextCursor: null,
      liveCursor: null,
      liveMore: false
    })
  )
}))

vi.mock('@/components/console/PlaygroundProvider', () => {
  const listeners = new Set<() => void>()
  const playground = {
    getLiveSteps: () => wire.live,
    isPgBusy: () => false,
    reconcileLiveSteps: () => {},
    markSessionTarget: (id: string) => wire.calls.push(`target:${id}`),
    pgAnswerElicitation: (id: string, agentId: string, requestId: string, value: unknown) =>
      wire.calls.push(`answer:${id}:${agentId}:${requestId}:${String(value)}`),
    pgSend: (id: string, agentId: string) => {
      wire.calls.push(`send:${id}:${agentId}:${wire.drafts[id] ?? ''}`)
      return true
    },
    setPgInput: (id: string, text: string) => {
      wire.drafts[id] = text
      listeners.forEach((listener) => listener())
    }
  }
  return {
    usePlayground: () => playground,
    usePgDraft: (id: string) => wire.drafts[id] ?? '',
    usePgDraftHasText: (id: string) => (wire.drafts[id] ?? '').trim() !== ''
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))

import { TaskThreadPanel } from './TaskThreadPanel'
import { renderWithIntl } from '@/i18n/test-utils'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const task = { title: 'Find what blocks api 1.5', sessionId: 'ses_task', how: 'opened' as const }

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let back: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  wire.canContinue = true
  wire.drafts = {}
  wire.live = []
  wire.calls = []
  back = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render() {
  await act(async () => {
    root.render(
      renderWithIntl(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <TaskThreadPanel
            agentId="agent_1"
            agentName="deploy-bot"
            task={task}
            parentSessionId="ses_coordinator"
            onBack={back}
          />
        </SWRConfig>
      )
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('TaskThreadPanel', () => {
  it('draws the task’s spoken messages and what this visit is streaming', async () => {
    wire.live = [{ kind: 'done', turnId: 't1', text: 'Rerunning CI on #1291.' }]
    await render()
    const said = [...container.querySelectorAll('[data-thread-message]')].map((el) => el.textContent)
    expect(said).toHaveLength(3)
    expect(said[0]).toContain('Dana Reyes')
    expect(said[0]).toContain('find what blocks api 1.5')
    expect(said[1]).toContain('deploy-bot')
    expect(said[2]).toContain('Rerunning CI on #1291.')
    expect(container.textContent).toContain('In progress: 3 of 5 release PRs are clear.')
    expect(container.textContent).not.toContain('gh pr list')
  })

  it('sends a reply onto the task’s own session', async () => {
    wire.drafts.ses_task = 'does 1.5 include the orders migration?'
    await render()
    const textarea = container.querySelector('textarea')!
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(wire.calls).toEqual(['target:ses_task', 'send:ses_task:agent_1:does 1.5 include the orders migration?'])
  })

  it('shows the agent’s open question and answers a plain choice from the panel', async () => {
    wire.live = [
      {
        kind: 'elicit',
        turnId: 't1',
        text: 'Merge #1291 now?',
        elicit: {
          requestId: 'q-1',
          options: [
            { value: 'yes', label: 'Merge' },
            { value: 'no', label: 'Wait' }
          ]
        }
      }
    ]
    await render()
    const question = container.querySelector('[data-thread-question="q-1"]')!
    expect(question.textContent).toContain('Waiting for your answer')
    expect(container.textContent).toContain('Merge #1291 now?')
    act(() =>
      Array.from(question.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Merge')!
        .click()
    )
    expect(wire.calls).toEqual(['target:ses_task', 'answer:ses_task:agent_1:q-1:yes'])
  })

  it('checks a typed answer against its constraints, and keeps it editable after sending', async () => {
    wire.live = [
      {
        kind: 'elicit',
        turnId: 't1',
        text: 'Which release tag?',
        elicit: { requestId: 'q-3', options: [], text: { minLength: 5 } }
      }
    ]
    await render()
    const question = container.querySelector('[data-thread-question="q-3"]')!
    const input = question.querySelector('input')!
    const submit = question.querySelector<HTMLButtonElement>('button[type="submit"]')!
    const type = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    type('v1.5')
    expect(question.querySelector('[data-thread-question-invalid]')?.textContent).toBe('Enter at least 5 characters')
    expect(submit.disabled).toBe(true)
    type('v1.5.0')
    act(() => submit.click())
    expect(wire.calls).toEqual(['target:ses_task', 'answer:ses_task:agent_1:q-3:v1.5.0'])
    // The daemon may still refuse it, so the answer stays editable and can be sent again once changed.
    expect(input.disabled).toBe(false)
    type('v1.5.1')
    act(() => submit.click())
    expect(wire.calls.at(-1)).toBe('answer:ses_task:agent_1:q-3:v1.5.1')
  })

  it('points a question the panel cannot answer to the task’s page', async () => {
    wire.live = [
      {
        kind: 'elicit',
        turnId: 't1',
        text: 'Fill in the release form',
        elicit: { requestId: 'q-2', options: [], fields: [] }
      }
    ]
    await render()
    const question = container.querySelector('[data-thread-question="q-2"]')!
    expect(question.querySelector('a')?.getAttribute('href')).toBe('/acme/sessions/ses_task')
    expect(question.querySelector('button')).toBeNull()
  })

  it('stays read-only where this reader may not continue the task', async () => {
    wire.canContinue = false
    await render()
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).toContain('You can read this task, but not reply to it here.')
  })

  it('expands into a large view over the page and comes back to the dock', async () => {
    await render()
    act(() => container.querySelector<HTMLButtonElement>('[data-task-thread-expand]')!.click())
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('[data-task-thread="ses_task"]')?.textContent).toContain('Three of five are clear.')
    expect(container.querySelector('[data-task-thread]')).toBeNull()
    expect(container.querySelector('[data-task-thread-placeholder]')).not.toBeNull()

    act(() => dialog.querySelector<HTMLButtonElement>('[data-task-thread-expand]')!.click())
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('[data-task-thread="ses_task"]')).not.toBeNull()
  })

  it('goes back to the task lists', async () => {
    await render()
    act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(back).toHaveBeenCalledTimes(1)
  })
})
