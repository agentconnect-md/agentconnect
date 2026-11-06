// @vitest-environment happy-dom

// A thread in the dock: a task's messages or a thread's record and what this visit streams, a reply onto the holding task's session, and read-only where the server says this reader may not continue it.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMessageDto } from '@/lib/api'
import type { Agent, SessionStep } from '@/lib/data'

const taskRow = vi.hoisted(() => ({
  sessionId: 'ses_task',
  title: 'Find what blocks api 1.5',
  state: 'open' as 'open' | 'done',
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
  calls: [] as string[],
  extra: [] as SessionMessageDto[],
  operations: [] as unknown[],
  permissionRequests: [] as unknown[],
  busy: false,
  /** What the thread record route answers: a page, or an error status with its code. */
  record: null as null | { status: number; code?: string } | Record<string, unknown>,
  recordReads: [] as string[]
}))

vi.mock(import('@/lib/api'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchSessionThreadMessages: vi.fn((sessionId: string, rootId: string, opts: { cursor?: string } = {}) => {
      wire.recordReads.push(`${sessionId}/${rootId}${opts.cursor ? `<${opts.cursor}` : ''}`)
      const answer = wire.record
      if (answer && 'status' in answer && typeof answer.status === 'number')
        return Promise.reject(new actual.ApiError('refused', answer.status, answer.code as string | undefined))
      if (opts.cursor)
        return Promise.resolve({
          ...(answer as object),
          messages: [
            {
              seq: 1,
              sender: 'user_dana',
              senderName: 'Dana Reyes',
              ts: '2026-11-03T09:00:00.000Z',
              kind: 'text',
              text: 'Why is the deploy slow?',
              postId: 'post-root'
            }
          ],
          nextCursor: null
        } as never)
      return Promise.resolve(answer as never)
    }),
    fetchAssistantSubsessions: vi.fn(() =>
      Promise.resolve({ subsessions: [taskRow], truncated: false, nextCursor: null })
    ),
    fetchAssistantSubsession: vi.fn(),
    fetchAgentPermissionRequests: vi.fn(() => Promise.resolve(wire.permissionRequests as never)),
    stopAssistantSubsession: vi.fn((_agent: string, id: string) => {
      wire.calls.push(`stop:${id}`)
      return Promise.resolve({ result: 'stopped' as const })
    }),
    listWebchatMcpOperations: vi.fn(() => Promise.resolve(wire.operations as never)),
    decideWebchatMcpOperation: vi.fn((_org: string, _agent: string, _conv: string, operationId: string) =>
      Promise.resolve({
        ...(wire.operations as { operationId: string }[]).find((op) => op.operationId === operationId),
        status: 'completed'
      } as never)
    ),
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
          { seq: 3, sender: 'agent_1', ts: '2026-11-03T09:02:00.000Z', kind: 'text', text: 'Three of five are clear.' },
          ...wire.extra
        ],
        nextCursor: null,
        liveCursor: null,
        liveMore: false
      })
    )
  }
})

vi.mock('@/components/console/PlaygroundProvider', () => {
  const listeners = new Set<() => void>()
  const playground = {
    getLiveSteps: () => wire.live,
    isPgBusy: () => wire.busy,
    pgCancel: (id: string, agentId: string) => wire.calls.push(`cancel:${id}:${agentId}`),
    reconcileLiveSteps: () => {},
    markSessionTarget: (id: string) => wire.calls.push(`target:${id}`),
    pgAnswerElicitation: (id: string, agentId: string, requestId: string, value: unknown) =>
      wire.calls.push(`answer:${id}:${agentId}:${requestId}:${String(value)}`),
    pgNotice: (id: string, agentId: string, text: string) => {
      wire.calls.push(`notice:${id}:${agentId}:${text}`)
      return true
    },
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
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
}))

// The avatar's image would fetch from the test origin; its own tests cover it.
vi.mock(import('@/components/marks'), async (importOriginal) => ({
  ...(await importOriginal()),
  AgentIconView: () => <span data-agent-avatar="" />
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org_acme' }, orgPath: (path: string) => `/acme${path}` })
}))

import { ThreadPanel } from './ThreadPanel'
import { DockExpandContext, type DockExpand } from './SessionDock'
import { renderWithIntl } from '@/i18n/test-utils'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const task = { title: 'Find what blocks api 1.5', sessionId: 'ses_task', how: 'opened' as const }

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let back: ReturnType<typeof vi.fn<() => void>>
let props: Partial<Parameters<typeof ThreadPanel>[0]> = {}
let withTask = true

beforeEach(() => {
  wire.canContinue = true
  wire.drafts = {}
  wire.live = []
  wire.calls = []
  wire.extra = []
  wire.permissionRequests = []
  wire.operations = []
  wire.busy = false
  wire.record = null
  wire.recordReads = []
  taskRow.state = 'open'
  props = {}
  withTask = true
  back = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const NO_DOCK: DockExpand = { available: false, expanded: false, setExpanded: () => {} }

async function render(dock: DockExpand = NO_DOCK) {
  await act(async () => {
    root.render(
      renderWithIntl(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <DockExpandContext.Provider value={dock}>
            <ThreadPanel
              agentId="agent_1"
              agentName="deploy-bot"
              {...(withTask ? { task } : {})}
              parentSessionId="ses_coordinator"
              onBack={back}
              {...props}
            />
          </DockExpandContext.Provider>
        </SWRConfig>
      )
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('ThreadPanel', () => {
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

  it('draws an agent turn as the session page does: its work folded under one header, then its answer', async () => {
    await render()
    const turn = container.querySelector('[data-thread-message="agent"]')!
    const fold = turn.querySelector<HTMLButtonElement>('[data-turn-fold]')!
    expect(fold.textContent).toContain('Worked for 1m 0s')
    expect(fold.textContent).toContain('Ran 1 command')
    expect(turn.querySelectorAll('[data-agent-prose]')).toHaveLength(1)
    expect(turn.textContent).not.toContain('gh pr list')
    await act(async () => fold.click())
    expect(turn.textContent).toContain('gh pr list')
  })

  it('dates a turn its own rows cannot measure from the message it answers', async () => {
    wire.extra = [
      { seq: 4, sender: 'user_dana', ts: '2026-11-03T09:03:00.000Z', kind: 'text', text: 'and the docs?' },
      { seq: 5, sender: 'agent_1', ts: '2026-11-03T09:04:00.000Z', kind: 'reasoning', text: 'Nothing to add' }
    ]
    await render()
    const folds = [...container.querySelectorAll('[data-turn-fold]')].map((el) => el.textContent)
    expect(folds.at(-1)).toContain('Worked for 1m 0s')
    expect(folds.at(-1)).toContain('Thought through 1 step')
  })

  it('heads the quick look with back, the task’s state, a link to its own page and close, and no crumb or branch', async () => {
    await render()
    const backButton = container.querySelector<HTMLButtonElement>('[data-task-thread-back]')!
    expect(backButton.getAttribute('aria-label')).toBe('Back to all tasks')
    expect(backButton.textContent).toBe('')
    expect(container.querySelector('[data-task-thread-branch]')).toBeNull()
    // Expanding a task is opening its own page, a real link a modified click takes to a new tab.
    const expand = container.querySelector('[data-task-thread-expand]')!
    expect(expand.tagName).toBe('A')
    expect(expand.getAttribute('href')).toBe('/acme/sessions/ses_task')
    act(() => backButton.click())
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('draws the task’s own approval in its thread, at the turn that asked', async () => {
    wire.permissionRequests = [
      {
        id: 'perm-1',
        agentId: 'agent_1',
        sessionId: 'ses_task',
        parentSessionId: 'ses_coordinator',
        createdAt: '2026-11-03T09:02:30.000Z',
        requesterId: null,
        requesterName: null,
        command: 'Bash: kubectl rollout restart',
        status: 'pending',
        resolvedAt: null,
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }]
      },
      // Another task's request stays out of this thread.
      {
        id: 'perm-2',
        agentId: 'agent_1',
        sessionId: 'ses_other',
        parentSessionId: 'ses_coordinator',
        createdAt: '2026-11-03T09:02:30.000Z',
        requesterId: null,
        requesterName: null,
        command: 'Bash: rm -rf build',
        status: 'pending',
        resolvedAt: null
      }
    ]
    props = { taskApprovals: { listSessionId: 'ses_coordinator', enabled: true, conversationPermissions: false } }
    await render()
    await render()
    const turn = container.querySelector('[data-thread-message="agent"]')!
    expect(turn.querySelector('[data-turn-approval="perm-1"]')?.textContent).toContain('kubectl rollout restart')
    expect(container.querySelector('[data-turn-approval="perm-2"]')).toBeNull()
  })

  it('stops a turn running here before the task list says it runs, by cancelling it as the conversation would', async () => {
    taskRow.state = 'done'
    wire.busy = true
    await render()
    const stop = container.querySelector<HTMLButtonElement>('[data-send-button="stop"]')!
    expect(stop).not.toBeNull()
    await act(async () => stop.click())
    expect(wire.calls).toContain('cancel:ses_task:agent_1')
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

  it('keeps an unfinished answer when the thread remounts, as switching the task view does', async () => {
    wire.live = [
      { kind: 'elicit', turnId: 't1', text: 'Which tag?', elicit: { requestId: 'q-keep', options: [], text: {} } }
    ]
    await render()
    const input = container.querySelector<HTMLInputElement>('[data-thread-question="q-keep"] input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'v1.5.')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => root.unmount())
    root = createRoot(container)
    props = {}
    await render()
    expect(container.querySelector<HTMLInputElement>('[data-thread-question="q-keep"] input')!.value).toBe('v1.5.')
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

  it('heads the thread with its title and state, and goes back from the crumb or the close button', async () => {
    await render()
    const header = container.querySelector('[data-task-thread="ses_task"] h3')!
    expect(header.textContent).toBe('Find what blocks api 1.5')
    expect(container.querySelector('[data-task-thread] [data-state-icon]')?.getAttribute('data-state-icon')).toBe(
      'running'
    )
    act(() => container.querySelector<HTMLButtonElement>('[data-task-thread-close]')!.click())
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('draws the person’s message as a bubble and the agent’s answer as prose, on their own sides', async () => {
    await render()
    const messages = Array.from(container.querySelectorAll('[data-thread-message]'))
    const said = messages.map((m) => [m.getAttribute('data-thread-message'), m.textContent])
    expect(said[0]).toEqual(['person', expect.stringContaining('find what blocks api 1.5')])
    expect(said[0]![1]).toContain('DR')
    expect(said[1]).toEqual(['agent', expect.stringContaining('Three of five are clear.')])
    expect(messages[0]!.querySelector('[data-agent-prose]')).toBeNull()
    expect(messages[1]!.querySelector('[data-agent-prose]')?.textContent).toContain('Three of five are clear.')
  })

  it('tells the reader who a reply reaches', async () => {
    await render()
    expect(container.querySelector('textarea')?.getAttribute('placeholder')).toBe(
      'Reply in this task — only this task sees it'
    )
    expect(container.querySelector('[data-task-thread-hint]')?.textContent).toBe('Only this task sees it')
  })

  it('draws another agent’s post as that agent, without its attribution line', async () => {
    const support = { id: 'agent_cs', name: 'customer-support', runtime: 'codex', icon: null } as unknown as Agent
    props = { agentById: new Map([['agent_cs', support]]), platform: 'slack' }
    const footer =
      'sent by <https://console.example.test/acme/agents/agent_cs|customer-support> (Codex · gpt-6.1-sol) · <https://console.example.test/acme/sessions/s1|open in session>'
    wire.extra = [
      {
        seq: 4,
        sender: 'B0SUPPORT',
        trustedAgentBot: true,
        ts: '2026-11-03T09:03:00.000Z',
        kind: 'text',
        text: `I only handle Acme support.\n\n${footer}`
      },
      { seq: 5, sender: 'B0STRANGER', ts: '2026-11-03T09:04:00.000Z', kind: 'text', text: `Not ours.\n\n${footer}` }
    ]
    await render()
    const peer = container.querySelector('[data-thread-agent="agent_cs"]')!
    expect(peer.getAttribute('data-thread-message')).toBe('agent')
    expect(peer.textContent).toContain('customer-support')
    expect(peer.textContent).toContain('I only handle Acme support.')
    expect(peer.textContent).not.toContain('sent by')
    // A bot whose provenance the daemon did not vouch for stays a person, attribution and all.
    const stranger = Array.from(container.querySelectorAll('[data-thread-message="person"]')).at(-1)!
    expect(stranger.textContent).toContain('Someone')
    expect(stranger.textContent).toContain('sent by')
  })

  it('shows a person’s own picture where the platform supplied one', async () => {
    wire.extra = [
      {
        seq: 4,
        sender: 'U0SAM',
        senderName: 'Sam',
        senderAvatarUrl: 'https://avatars.example/sam.png',
        ts: '2026-11-03T09:03:00.000Z',
        kind: 'text',
        text: 'Rerun it.'
      }
    ]
    await render()
    const avatars = Array.from(container.querySelectorAll<HTMLImageElement>('[data-thread-avatar]'))
    expect(avatars.map((img) => img.getAttribute('src'))).toEqual(['https://avatars.example/sam.png'])
  })

  it('shows a member’s console photo where the platform supplied none, and the reader’s own for this visit’s sends', async () => {
    const asked: (string | undefined)[] = []
    props = {
      personPicture: (sender) => {
        asked.push(sender)
        return sender === 'user_dana' ? 'https://avatars.example/dana.png' : 'https://avatars.example/me.png'
      }
    }
    wire.live = [{ kind: 'msg', text: 'and the sixth?' } as SessionStep]
    await render()
    const avatars = Array.from(container.querySelectorAll<HTMLImageElement>('[data-thread-avatar]'))
    expect(avatars.map((img) => img.getAttribute('src'))).toEqual([
      'https://avatars.example/dana.png',
      'https://avatars.example/me.png'
    ])
    expect(asked).toContain(undefined)
  })

  it('opens the agent’s page from its mark', async () => {
    await render()
    const link = container.querySelector('[data-thread-message="agent"] [data-thread-agent-link]')
    expect(link?.getAttribute('href')).toBe('/acme/agents/agent_1')
  })

  it('asks for approval of only the writes this task raised, and tells the task the outcome', async () => {
    const pending = (operationId: string, toolName: string) => ({
      operationId,
      toolName,
      arguments: {},
      status: 'awaiting_confirmation',
      createdAt: '2026-11-03T09:03:00.000Z',
      confirmationExpiresAt: '2026-11-03T09:13:00.000Z',
      completedAt: null
    })
    const mine = '6f1d3c55-0a3e-4b8e-9d55-6a4c1b7e2f10'
    wire.operations = [pending(mine, 'updateAgent'), pending('0b6c9d2e-5f8a-4c1b-8e3d-7a9f2c4e6b11', 'deleteCron')]
    wire.extra = [
      {
        seq: 4,
        sender: 'agent_1',
        ts: '2026-11-03T09:03:00.000Z',
        kind: 'tool',
        text: 'updateAgent',
        body: JSON.stringify({ output: JSON.stringify({ status: 'awaiting_confirmation', operationId: mine }) })
      }
    ]
    props = { approvals: { orgId: 'org1', conversationId: 'conv_coordinator' } }
    await render()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const approve = [...container.querySelectorAll('button')].filter((b) => b.textContent?.includes('Approve'))
    expect(approve).toHaveLength(1)
    expect(container.textContent).toContain('updateAgent')
    expect(container.textContent).not.toContain('deleteCron')
    await act(async () => approve[0]!.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(wire.calls).toContain('target:ses_task')
    expect(wire.calls.find((call) => call.startsWith('notice:ses_task:agent_1:'))).toContain(mine)
  })

  it('goes back to the task lists', async () => {
    await render()
    act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(back).toHaveBeenCalledTimes(1)
  })
})

const reply = (
  seq: number,
  sender: string,
  text: string,
  over: Partial<SessionMessageDto> = {}
): SessionMessageDto => ({
  seq,
  sender,
  ts: `2026-11-03T09:0${seq}:00.000Z`,
  kind: 'text',
  text,
  ...over
})

function recordPage(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'ses_coordinator',
    rootId: 'post-root',
    messages: [
      reply(1, 'user_dana', 'Why is the deploy slow?', { senderName: 'Dana Reyes', postId: 'post-root' }),
      reply(2, 'agent_1', 'The cache misses on every build.'),
      reply(3, 'user_lee', 'Can you fix it?', { senderName: 'Lee Park' })
    ],
    nextCursor: null,
    liveCursor: null,
    liveMore: false,
    summary: { rootId: 'post-root', replies: 2, participants: [], readable: true },
    ...over
  }
}

describe('ThreadPanel on a thread’s record (webchat-threads.md §6.2)', () => {
  const ref = { sessionId: 'ses_coordinator', rootId: 'post-root' }

  it('reads an unowned thread through the conversation: the root first, a plain header, and no composer yet', async () => {
    wire.record = recordPage()
    withTask = false
    props = { record: ref }
    await render()
    expect(wire.recordReads).toEqual(['ses_coordinator/post-root'])
    const panel = container.querySelector('[data-thread-panel="post-root"]')!
    expect(panel.hasAttribute('data-task-thread')).toBe(false)
    const said = [...panel.querySelectorAll('[data-thread-message]')].map((el) => el.textContent)
    expect(said).toHaveLength(3)
    expect(said[0]).toContain('Why is the deploy slow?')
    expect(said[1]).toContain('The cache misses on every build.')
    expect(said[2]).toContain('Lee Park')
    expect(panel.querySelector('h3')?.textContent).toBe('Thread')
    expect(panel.querySelector('[data-state-icon]')).toBeNull()
    expect(panel.querySelector('[data-task-thread-expand]')).toBeNull()
    expect(panel.querySelector('textarea')).toBeNull()
    expect(panel.textContent).not.toContain('You can read this task')
  })

  it('names the holding task from the footer, heads with it and continues it from the composer', async () => {
    wire.record = recordPage({
      summary: {
        rootId: 'post-root',
        replies: 2,
        participants: [],
        task: { sessionId: 'ses_task', title: 'Find what blocks api 1.5', state: 'open' },
        readable: true
      }
    })
    withTask = false
    props = { record: ref }
    await render()
    const panel = container.querySelector('[data-thread-panel="post-root"]')!
    expect(panel.getAttribute('data-task-thread')).toBe('ses_task')
    expect(panel.querySelector('h3')?.textContent).toBe('Find what blocks api 1.5')
    expect(panel.querySelector('[data-task-thread-expand]')?.getAttribute('href')).toBe('/acme/sessions/ses_task')
    // The record is the thread; the task's own session history is not read.
    expect(panel.textContent).not.toContain('find what blocks api 1.5')
    expect(panel.textContent).toContain('Can you fix it?')
    wire.drafts.ses_task = 'try a warm cache'
    act(() => {
      panel
        .querySelector<HTMLTextAreaElement>('textarea')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(wire.calls).toContain('send:ses_task:agent_1:try a warm cache')
  })

  it('shows a thread whose task the reader may not view as unreadable, with no content and no composer', async () => {
    wire.record = recordPage({
      messages: [],
      summary: {
        rootId: 'post-root',
        replies: 4,
        participants: [],
        task: { sessionId: 'ses_task', state: 'open' },
        readable: false
      }
    })
    withTask = false
    props = { record: ref }
    await render()
    const panel = container.querySelector('[data-thread-panel="post-root"]')!
    expect(panel.querySelector('[data-thread-unreadable]')).not.toBeNull()
    expect(panel.hasAttribute('data-task-thread')).toBe(false)
    expect(panel.querySelectorAll('[data-thread-message]')).toHaveLength(0)
    expect(panel.querySelector('textarea')).toBeNull()
    expect(panel.querySelector('[data-task-thread-expand]')).toBeNull()
  })

  it('reads a task’s session where its daemon cannot serve thread reads', async () => {
    wire.record = { status: 409, code: 'DAEMON_FEATURE_MISSING' }
    props = { record: ref }
    await render()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(wire.recordReads).toEqual(['ses_coordinator/post-root'])
    const said = [...container.querySelectorAll('[data-thread-message]')].map((el) => el.textContent)
    expect(said[0]).toContain('find what blocks api 1.5')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('says a root the conversation never received is not here', async () => {
    wire.record = { status: 404 }
    withTask = false
    props = { record: ref }
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('This thread isn’t in this conversation.')
  })

  it('pages in earlier messages of a long thread, drawing each row once', async () => {
    wire.record = recordPage({
      messages: [reply(2, 'agent_1', 'The cache misses on every build.'), reply(3, 'user_lee', 'Can you fix it?')],
      nextCursor: 'c-older'
    })
    withTask = false
    props = { record: ref }
    await render()
    expect(container.querySelectorAll('[data-thread-message]')).toHaveLength(2)
    await act(async () => container.querySelector<HTMLButtonElement>('[data-thread-earlier]')!.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(wire.recordReads).toEqual(['ses_coordinator/post-root', 'ses_coordinator/post-root<c-older'])
    const said = [...container.querySelectorAll('[data-thread-message]')].map((el) => el.textContent)
    expect(said).toHaveLength(3)
    expect(said[0]).toContain('Why is the deploy slow?')
    expect(container.querySelector('[data-thread-earlier]')).toBeNull()
  })
})
