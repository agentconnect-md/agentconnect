// @vitest-environment happy-dom

// A thread in the dock: a task's messages or a thread's record and what this visit streams, a reply onto the holding task's session, and read-only where the server says this reader may not continue it.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMessageDto } from '@/lib/api'
import type { Agent, SessionStep } from '@/lib/data'
import type { ComposerFile } from '@/lib/webchat-file'
import type { PlaygroundData } from '@/components/console/playground/contract'

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
  files: {} as Record<string, ComposerFile[]>,
  sentFiles: [] as unknown[],
  live: [] as SessionStep[],
  calls: [] as string[],
  extra: [] as SessionMessageDto[],
  operations: [] as unknown[],
  permissionRequests: [] as unknown[],
  busy: false,
  /** The thread the conversation's turn in flight was sent in. */
  turnThread: undefined as string | undefined,
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
      // A root other than the first never answers, as a read still on its way.
      if (rootId !== 'post-root') return new Promise<never>(() => {})
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
    fetchSessionDetail: vi.fn(() =>
      Promise.resolve({ id: 'ses_task', channel: 'conv-task', canContinue: wire.canContinue } as never)
    ),
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
    getPgInput: (id: string) => wire.drafts[id] ?? '',
    getPgTurnThread: () => wire.turnThread,
    isPgBusy: () => wire.busy,
    getPgImage: () => undefined,
    setPgImage: () => {},
    getPgFiles: (id: string) => wire.files[id] ?? [],
    setPgFiles: (id: string, update: (files: ComposerFile[]) => ComposerFile[]) => {
      wire.files[id] = update(wire.files[id] ?? [])
    },
    pgCancel: (id: string, agentId: string) => wire.calls.push(`cancel:${id}:${agentId}`),
    reconcileLiveSteps: () => {},
    markSessionTarget: (id: string, target?: string, threads?: boolean) =>
      wire.calls.push(`target:${id}${target ? `:${target}` : ''}${threads ? ':threads' : ''}`),
    pgAttach: (id: string, agentId: string, conversationId: string) =>
      wire.calls.push(`attach:${id}:${agentId}:${conversationId}`),
    pgAnswerElicitation: (id: string, agentId: string, requestId: string, value: unknown, conversationId?: string) =>
      wire.calls.push(`answer:${id}:${agentId}:${requestId}:${String(value)}:${conversationId}`),
    pgAnswerFill: async (id: string, agentId: string, requestId: string, answer: unknown, conversationId?: string) => {
      wire.calls.push(`fill:${id}:${agentId}:${requestId}:${JSON.stringify(answer)}:${conversationId}`)
      return { accepted: true }
    },
    pgNotice: (id: string, agentId: string, text: string) => {
      wire.calls.push(`notice:${id}:${agentId}:${text}`)
      return true
    },
    pgSend: (id: string, agentId: string) => {
      wire.calls.push(`send:${id}:${agentId}:${wire.drafts[id] ?? ''}`)
      return true
    },
    pgSendThread: (
      ...[id, agentId, text, thread, conversationId, , files]: Parameters<PlaygroundData['pgSendThread']>
    ) => {
      wire.calls.push(`thread:${id}:${agentId}:${text}:${thread}${conversationId ? `:${conversationId}` : ''}`)
      wire.sentFiles.push(files)
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

vi.mock('@/lib/data-context', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useConsoleData: () => ({ revalidateSessionLists: () => Promise.resolve() })
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org_acme' }, orgPath: (path: string) => `/acme${path}` })
}))

import { ThreadPanel } from './ThreadPanel'
import type { Turn } from '../session-turns'
import { msgStep } from '../transcript-steps'
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
  wire.files = {}
  wire.sentFiles = []
  wire.live = []
  wire.calls = []
  wire.extra = []
  wire.permissionRequests = []
  wire.operations = []
  wire.busy = false
  wire.turnThread = undefined
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
  vi.restoreAllMocks()
})

async function render() {
  await act(async () => {
    root.render(
      renderWithIntl(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <ThreadPanel
            agentId="agent_1"
            agentName="deploy-bot"
            {...(withTask ? { task } : {})}
            parentSessionId="ses_coordinator"
            onBack={back}
            {...props}
          />
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
    expect(fold.textContent).toBe('1m 0s')
    expect(fold.title).toBe('Worked for 1m 0s · ran 1 command')
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
    const folds = [...container.querySelectorAll<HTMLButtonElement>('[data-turn-fold]')]
    expect(folds.at(-1)?.textContent).toBe('1m 0s')
    expect(folds.at(-1)?.title).toBe('Worked for 1m 0s · thought through 1 step')
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

  it('shares the task’s own session from its header, as the session page does', async () => {
    vi.spyOn(window.location, 'href', 'get').mockReturnValue('https://console.example.test/acme/sessions/owner')
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    await render()
    const share = container.querySelector<HTMLButtonElement>('[data-task-thread-share]')!
    expect(share.getAttribute('aria-label')).toBe('Share')
    await act(async () => share.click())
    const dialog = document.querySelector('[data-share-dialog]')!
    expect(dialog?.textContent).toContain('Copy link')
    await act(async () =>
      [...dialog.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Copy link')!
        .click()
    )
    expect(write).toHaveBeenCalledWith('https://console.example.test/acme/sessions/ses_task')
    expect(document.querySelector('[data-share-dialog]')).toBeNull()
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Link copied')
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

  it('draws the task’s Fill card and answers it on the conversation’s own socket and channel', async () => {
    wire.live = [
      {
        kind: 'fill',
        turnId: 't1',
        text: 'https://login.example.test',
        fill: {
          requestId: '7f9d6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f',
          computerName: 'Desk',
          website: { origin: 'https://login.example.test' },
          kind: 'login',
          fields: [
            {
              id: 'f1',
              control: 'password',
              purpose: 'current-password',
              label: 'Password',
              required: true,
              secret: true,
              empty: true
            }
          ],
          expiresAt: new Date(Date.now() + 600_000).toISOString()
        }
      }
    ]
    await render()
    const card = container.querySelector('[data-fill-card]')!
    expect(card.textContent).toContain('https://login.example.test')
    const input = card.querySelector<HTMLInputElement>('input[aria-label="Password"]')!
    expect(input.type).toBe('password')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, 'canary-thread-pass')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => card.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(wire.calls).toEqual([
      'fill:ses_coordinator:agent_1:7f9d6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f:{"values":[{"field":"f1","value":"canary-thread-pass"}]}:conv-task'
    ])
    expect(container.innerHTML).not.toContain('canary-thread-pass')
  })

  it('draws the agent’s open question as the session page does, and answers it on the task’s session', async () => {
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
    const turn = container.querySelector('[data-thread-message="agent"]:last-of-type')!
    expect(turn.textContent).toContain('Merge #1291 now?')
    act(() =>
      Array.from(turn.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Merge')!
        .click()
    )
    // The answer rides the conversation's own socket on the shared channel, never a continuation socket targeting the task.
    expect(wire.calls).toEqual(['answer:ses_coordinator:agent_1:q-1:yes:conv-task'])
  })

  it('checks a typed answer against its constraints before sending it', async () => {
    wire.live = [
      {
        kind: 'elicit',
        turnId: 't1',
        text: 'Which release tag?',
        elicit: { requestId: 'q-3', options: [], text: { minLength: 5 } }
      }
    ]
    await render()
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Your answer"]')!
    const submit = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Submit')!
    const type = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    type('v1.5')
    expect(container.textContent).toContain('Enter at least 5 characters')
    expect(submit().disabled).toBe(true)
    type('v1.5.0')
    act(() => submit().click())
    expect(wire.calls).toEqual(['answer:ses_coordinator:agent_1:q-3:v1.5.0:conv-task'])
  })

  it('keeps an unfinished answer when the thread remounts, as switching the task view does', async () => {
    wire.live = [
      { kind: 'elicit', turnId: 't1', text: 'Which tag?', elicit: { requestId: 'q-keep', options: [], text: {} } }
    ]
    await render()
    const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Your answer"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), 'v1.5.')
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => root.unmount())
    root = createRoot(container)
    await render()
    expect(input().value).toBe('v1.5.')
  })

  it('keeps a settled question in the thread with its outcome, and offers nothing to answer', async () => {
    wire.extra = [
      {
        seq: 4,
        sender: 'agent_1',
        ts: '2026-11-03T09:03:00.000Z',
        kind: 'elicit',
        text: 'Merge #1291 now?',
        body: JSON.stringify({ requestId: 'q-old', options: [{ value: 'yes', label: 'Merge' }], outcome: 'cancelled' })
      }
    ]
    await render()
    expect(container.textContent).toContain('Merge #1291 now?')
    expect(container.textContent).toContain('Cancelled')
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Merge')).toBe(false)
  })

  it('draws the turn’s plan as its own block, as the session page does', async () => {
    wire.extra = [
      {
        seq: 4,
        sender: 'agent_1',
        ts: '2026-11-03T09:03:00.000Z',
        kind: 'plan',
        text: 'Plan · 1/2',
        body: JSON.stringify({
          entries: [
            { content: 'Check the release PRs', status: 'completed' },
            { content: 'Rerun CI on #1291', status: 'in_progress' }
          ]
        })
      }
    ]
    await render()
    const turn = container.querySelector('[data-thread-message="agent"]')!
    expect(turn.textContent).toContain('Check the release PRs')
    expect(turn.textContent).toContain('Rerun CI on #1291')
  })

  it('draws a shared image as its card and a person’s attached images inline, never as raw markers', async () => {
    const preview = { name: 'chart.png', mimeType: 'image/png' as const, data: btoa('png-bytes') }
    wire.extra = [
      {
        seq: 4,
        sender: 'user_dana',
        senderName: 'Dana Reyes',
        ts: '2026-11-03T09:03:00.000Z',
        kind: 'text',
        text: 'like this one',
        attachments: [preview]
      },
      {
        seq: 5,
        sender: 'agent_1',
        ts: '2026-11-03T09:04:00.000Z',
        kind: 'text',
        text: 'revenue by week\n[shared: out/chart.png (image/png, 9 bytes, sha256:1a2b3c4d5e6f7a8b)]',
        postId: '11111111-1111-4111-8111-111111111111',
        sharedImage: { attachment: preview, original: { kind: 'inline' }, revision: 0 }
      }
    ]
    await render()
    expect(container.querySelectorAll('[data-testid="shared-image-card"]')).toHaveLength(1)
    expect(container.querySelector('img[alt="revenue by week"]')).not.toBeNull()
    expect(container.querySelector('[data-thread-message="person"] img[alt="chart.png"]')).not.toBeNull()
    expect(container.textContent).not.toContain('[shared:')
  })

  it('stays read-only where this reader may not continue the task', async () => {
    wire.canContinue = false
    await render()
    expect(container.querySelector('textarea')).toBeNull()
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

  it('says who a reply reaches in its placeholder, and offers to attach a file where the hint was', async () => {
    await render()
    expect(container.querySelector('textarea')?.getAttribute('placeholder')).toBe(
      'Reply in this task — only this task sees it'
    )
    expect(container.querySelector('[data-task-thread-hint]')).toBeNull()
    const attach = container.querySelector<HTMLButtonElement>('[data-task-thread-attach]')
    expect(attach?.getAttribute('aria-label')).toBe('Attach a file')
    expect(container.querySelector('input[type="file"]')).not.toBeNull()
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
    const avatars = Array.from(container.querySelectorAll<HTMLImageElement>('[data-thread-message="person"] img'))
    expect(avatars.map((img) => img.getAttribute('src'))).toEqual(['https://avatars.example/sam.png'])
  })

  // The session page's reading of who a sender is, with the reader signed in as `me`.
  const peopleAs = (me: string) => ({
    isSelf: (sender?: string | null) => sender === me,
    label: (sender: string | null | undefined, fallback?: string) =>
      sender === me ? 'You' : sender === 'user_dana' ? 'Dana Reyes' : (fallback ?? sender ?? ''),
    pictureOf: (sender: string) => (sender === 'user_dana' ? 'https://avatars.example/dana.png' : undefined),
    viewer: { picture: 'https://avatars.example/me.png' }
  })

  it('shows a member’s console photo where the platform supplied none, and the reader’s own for this visit’s sends', async () => {
    props = { people: peopleAs('user_me') }
    wire.live = [{ kind: 'msg', text: 'and the sixth?' } as SessionStep]
    await render()
    const avatars = Array.from(container.querySelectorAll<HTMLImageElement>('[data-thread-message="person"] img'))
    expect(avatars.map((img) => img.getAttribute('src'))).toEqual([
      'https://avatars.example/dana.png',
      'https://avatars.example/me.png'
    ])
  })

  it('reads a recorded message of the reader’s own as theirs, as the session page does', async () => {
    props = { people: peopleAs('user_dana') }
    await render()
    const own = container.querySelector('[data-thread-message="person"]')!
    expect(own.textContent).toContain('You')
    expect(own.querySelector('img')?.getAttribute('src')).toBe('https://avatars.example/me.png')
  })

  it('reads a message from the chat account the reader linked as theirs, naming the platform', async () => {
    props = { people: peopleAs('user_me'), platform: 'slack' }
    wire.extra = [
      {
        seq: 4,
        sender: 'U0ME',
        senderName: 'Morgan',
        senderUserId: 'user_me',
        ts: '2026-11-03T09:03:00.000Z',
        kind: 'text',
        text: 'Rerun it.'
      }
    ]
    await render()
    const own = Array.from(container.querySelectorAll('[data-thread-message="person"]')).at(-1)!
    expect(own.textContent).toContain('You (Slack)')
    expect(own.querySelector('img')?.getAttribute('src')).toBe('https://avatars.example/me.png')
  })

  it('opens the agent’s page from its mark', async () => {
    const coordinator = { id: 'agent_1', name: 'deploy-bot', runtime: 'claude', icon: null } as unknown as Agent
    props = { agentById: new Map([['agent_1', coordinator]]) }
    await render()
    const link = container.querySelector('[data-thread-message="agent"] a[aria-label="deploy-bot"]')
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

  it('reads an unowned thread through the conversation: the root first, a plain header, and no composer for another member', async () => {
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
    expect(panel.querySelector('[data-task-thread-share]')).toBeNull()
    expect(panel.querySelector('textarea')).toBeNull()
    expect(panel.textContent).not.toContain('You can read this task')
  })

  it('names the holding task from the footer, heads with it and continues it in this thread from the composer', async () => {
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
    props = { record: ref, platform: 'webchat' }
    // A reply sends only what is drafted when the composer draws.
    wire.drafts.ses_task = 'try a warm cache'
    await render()
    const panel = container.querySelector('[data-thread-panel="post-root"]')!
    expect(panel.getAttribute('data-task-thread')).toBe('ses_task')
    expect(panel.querySelector('h3')?.textContent).toBe('Find what blocks api 1.5')
    expect(panel.querySelector('[data-task-thread-expand]')?.getAttribute('href')).toBe('/acme/sessions/ses_task')
    // The record is the thread; the task's own session history is not read.
    expect(panel.textContent).not.toContain('find what blocks api 1.5')
    expect(panel.textContent).toContain('Can you fix it?')
    act(() => {
      panel
        .querySelector<HTMLTextAreaElement>('textarea')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    // Another member writes through the task, in this thread of the several it may hold.
    expect(wire.calls).toContain('thread:ses_task:agent_1:try a warm cache:post-root')
    expect(wire.drafts.ses_task).toBe('')
  })

  it('draws the coordinator’s work on the thread from the main timeline under its root, above a divider and the replies', async () => {
    wire.record = recordPage()
    withTask = false
    const work: Turn = {
      kind: 'bot',
      key: 'b-main:in:post-root',
      agentName: 'deploy-bot',
      agentId: 'agent_1',
      model: '',
      time: '',
      steps: [{ ...msgStep(reply(4, 'agent_1', 'Opened a task to look into the cache.')), thread: 'post-root' }]
    }
    props = { record: ref, fromMain: [work] }
    await render()
    const panel = container.querySelector('[data-thread-panel="post-root"]')!
    const order = [...panel.querySelectorAll('[data-thread-message], [data-thread-replies-divider]')].map((el) =>
      el.hasAttribute('data-thread-replies-divider') ? 'divider' : el.textContent
    )
    expect(order).toHaveLength(5)
    expect(order[0]).toContain('Why is the deploy slow?')
    expect(order[1]).toContain('Opened a task to look into the cache.')
    expect(order[2]).toBe('divider')
    expect(order[3]).toContain('The cache misses on every build.')
    expect(order[4]).toContain('Can you fix it?')
    expect(panel.querySelector('[data-thread-replies-divider]')?.textContent).toBe('Replies')
  })

  it('marks a message the coordinator redirected here from the conversation', async () => {
    wire.record = recordPage({
      messages: [
        reply(1, 'user_dana', 'Why is the deploy slow?', { senderName: 'Dana Reyes', postId: 'post-root' }),
        reply(2, 'agent_1', 'The cache misses on every build.'),
        reply(3, 'user_dana', 'Will it rain tomorrow?', { senderName: 'Dana Reyes', handedTo: 'post-root' })
      ]
    })
    withTask = false
    const shown: number[] = []
    props = { record: ref, onShowInConversation: (seq: number) => shown.push(seq) }
    await render()
    const marked = [...container.querySelectorAll('[data-thread-redirected]')]
    expect(marked).toHaveLength(1)
    expect(marked[0]!.textContent).toContain('Redirected from coordinator')
    expect(marked[0]!.textContent).toContain('Will it rain tomorrow?')
    // Its label opens the message where it was said, on the main timeline.
    act(() => marked[0]!.querySelector<HTMLButtonElement>('[data-thread-redirected-from]')!.click())
    expect(shown).toEqual([3])
  })

  it('shares a message by the holding task’s page, else by this thread’s address, with the message’s anchor', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => (written.push(text), Promise.resolve()) }
    })
    const copyFirstMessage = async () => {
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[data-msg-seq="1"] [data-message-share]')!.click()
      )
      const copy = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (b) => b.textContent === 'Copy link'
      )!
      await act(async () => copy.click())
    }
    // An unowned thread: the conversation with the thread open.
    wire.record = recordPage()
    withTask = false
    props = { record: ref }
    await render()
    await copyFirstMessage()
    expect(written.at(-1)).toBe(`${location.origin}${location.pathname}?thread=post-root#msg=1`)
    act(() => root.unmount())
    root = createRoot(container)
    // A thread a task holds: the task's own page.
    wire.record = recordPage({
      summary: {
        rootId: 'post-root',
        replies: 2,
        participants: [],
        task: { sessionId: 'ses_task', title: 'Find what blocks api 1.5', state: 'open' },
        readable: true
      }
    })
    await render()
    await copyFirstMessage()
    expect(written.at(-1)).toBe(`${location.origin}/acme/sessions/ses_task#msg=1`)
  })

  it('draws no divider over a page that starts after the root', async () => {
    wire.record = recordPage({
      messages: [reply(3, 'user_lee', 'Can you fix it?', { senderName: 'Lee Park' }), reply(4, 'agent_1', 'On it.')],
      nextCursor: 'c-older'
    })
    withTask = false
    props = { record: ref }
    await render()
    expect(container.querySelectorAll('[data-thread-message]')).toHaveLength(2)
    expect(container.querySelector('[data-thread-replies-divider]')).toBeNull()
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

describe('ThreadPanel on a Slack thread’s record (webchat-threads.md §7)', () => {
  const ref = { sessionId: 'ses_coordinator', rootId: 'post-root' }
  const held = {
    rootId: 'post-root',
    replies: 2,
    participants: [],
    task: { sessionId: 'ses_task', title: 'Find what blocks api 1.5', state: 'open' as const },
    readable: true
  }

  it('continues the holding task as its page does, mirrored into the Slack thread, and links the thread', async () => {
    wire.record = recordPage({ summary: held })
    withTask = false
    props = {
      record: ref,
      platform: 'slack',
      threadUrl: 'https://app.slack.com/client/T0EXAMPLE/C0EXAMPLE/thread/C0EXAMPLE-1754123456.000200'
    }
    wire.drafts.ses_task = 'try a warm cache'
    await render()
    const panel = container.querySelector('[data-thread-panel="post-root"]')!
    const link = panel.querySelector<HTMLAnchorElement>('[data-thread-platform-link]')
    expect(link?.getAttribute('href')).toBe(props.threadUrl)
    expect(link?.getAttribute('aria-label')).toBe('Open in Slack')
    expect(panel.querySelector('[data-task-thread-hint]')).toBeNull()
    expect(panel.querySelector('[data-task-thread-attach]')).not.toBeNull()
    act(() => {
      panel
        .querySelector<HTMLTextAreaElement>('textarea')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    // A Slack task's continuation names no thread: the daemon writes it in the task's own.
    expect(wire.calls).toContain('send:ses_task:agent_1:try a warm cache')
    expect(wire.calls.some((call) => call.startsWith('thread:'))).toBe(false)
  })

  it('offers no composer in an unowned Slack thread to a reader who may not continue its coordinator, and no link without one', async () => {
    wire.record = recordPage()
    withTask = false
    props = { record: ref, platform: 'slack' }
    await render()
    const panel = container.querySelector('[data-thread-panel="post-root"]')!
    expect(panel.querySelectorAll('[data-thread-message]')).toHaveLength(3)
    expect(panel.querySelector('textarea')).toBeNull()
    expect(panel.querySelector('[data-thread-platform-link]')).toBeNull()
  })

  it('writes in an unowned Slack thread through the continued coordinator, mirrored there (webchat-threads.md §7)', async () => {
    wire.record = recordPage()
    withTask = false
    props = { record: ref, platform: 'slack', writer: { sessionId: 'ses_coordinator', continues: 'ses_coordinator' } }
    wire.drafts['ses_coordinator#post-root'] = 'and the cache?'
    await render()
    const panel = container.querySelector('[data-thread-panel="post-root"]')!
    expect(panel.querySelector('[data-task-thread-hint]')).toBeNull()
    expect(panel.querySelector('[data-task-thread-attach]')).not.toBeNull()
    act(() => {
      panel
        .querySelector<HTMLTextAreaElement>('textarea')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(wire.calls).toEqual([
      'target:ses_coordinator:ses_coordinator:threads',
      'thread:ses_coordinator:agent_1:and the cache?:post-root'
    ])
  })

  it('keeps a mirrored Slack thread text-only when its daemon cannot continue attachments', async () => {
    wire.record = recordPage()
    withTask = false
    props = {
      record: ref,
      platform: 'slack',
      writer: { sessionId: 'ses_coordinator', continues: 'ses_coordinator' },
      attachments: false
    }
    await render()
    expect(container.querySelector('[data-task-thread-attach]')).toBeNull()
  })

  it('continues the holding task in a held Slack thread even where the reader may write to its coordinator', async () => {
    wire.record = recordPage({ summary: held })
    withTask = false
    props = { record: ref, platform: 'slack', writer: { sessionId: 'ses_coordinator', continues: 'ses_coordinator' } }
    wire.drafts.ses_task = 'try a warm cache'
    await render()
    const panel = container.querySelector('[data-thread-panel="post-root"]')!
    expect(panel.querySelector('[data-task-thread-hint]')).toBeNull()
    expect(panel.querySelector('[data-task-thread-attach]')).not.toBeNull()
    act(() => {
      panel
        .querySelector<HTMLTextAreaElement>('textarea')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(wire.calls).toContain('send:ses_task:agent_1:try a warm cache')
    expect(wire.calls.some((call) => call.startsWith('thread:'))).toBe(false)
  })
})

describe('ThreadPanel switching or polling a thread’s record', () => {
  const held = {
    rootId: 'post-root',
    replies: 2,
    participants: [],
    task: { sessionId: 'ses_task', title: 'Find what blocks api 1.5', state: 'open' },
    readable: true
  }

  it('never shows another thread’s record or replies to its task while the new one loads', async () => {
    wire.record = recordPage({ summary: held })
    withTask = false
    props = { record: { sessionId: 'ses_coordinator', rootId: 'post-root' } }
    await render()
    expect(container.querySelector('[data-thread-panel="post-root"]')?.getAttribute('data-task-thread')).toBe(
      'ses_task'
    )
    expect(container.querySelector('textarea')).not.toBeNull()

    props = { record: { sessionId: 'ses_coordinator', rootId: 'post-other' } }
    await render()
    const panel = container.querySelector('[data-thread-panel="post-other"]')!
    expect(panel.hasAttribute('data-task-thread')).toBe(false)
    expect(panel.querySelectorAll('[data-thread-message]')).toHaveLength(0)
    expect(panel.querySelector('textarea')).toBeNull()
    expect(panel.textContent).toContain('Loading the thread…')
  })

  it('keeps every row it showed when a later read’s newest page has moved past them', async () => {
    wire.record = recordPage({
      messages: [reply(2, 'agent_1', 'The cache misses on every build.'), reply(3, 'user_lee', 'Can you fix it?')],
      nextCursor: 'c-older',
      summary: held
    })
    withTask = false
    wire.busy = true
    props = { record: { sessionId: 'ses_coordinator', rootId: 'post-root' } }
    await render()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-thread-earlier]')!.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    // A turn ends here, so the record is read again; its newest page no longer carries row 2.
    wire.record = recordPage({
      messages: [reply(3, 'user_lee', 'Can you fix it?'), reply(4, 'agent_1', 'Warmed the cache.')],
      summary: held
    })
    wire.busy = false
    await render()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    // Another turn ends, and the newest page has moved past row 4 too, which arrived after the earlier page was read.
    wire.record = recordPage({
      messages: [reply(5, 'user_lee', 'Thanks!'), reply(6, 'agent_1', 'Anytime.')],
      summary: held
    })
    wire.busy = true
    await render()
    wire.busy = false
    await render()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(wire.recordReads).toEqual([
      'ses_coordinator/post-root',
      'ses_coordinator/post-root<c-older',
      'ses_coordinator/post-root',
      'ses_coordinator/post-root'
    ])
    const said = [...container.querySelectorAll('[data-thread-message]')].map((el) => el.textContent ?? '')
    expect(said.join('|')).toMatch(
      /Why is the deploy slow\?.*The cache misses.*Can you fix it\?.*Warmed the cache\..*Thanks!.*Anytime\./
    )
  })
})

describe('ThreadPanel for the conversation’s owner (webchat-threads.md §6.3)', () => {
  const ref = { sessionId: 'ses_coordinator', rootId: 'post-root' }
  const writer = { sessionId: 'ses_coordinator', conversationId: 'conv-1' }
  const step = (over: Partial<SessionStep> & Pick<SessionStep, 'kind' | 'text'>): SessionStep => ({
    turnId: 't1',
    ...over
  })

  it('sends a mixed attachment-only reply in its thread and clears only that draft', async () => {
    wire.record = recordPage()
    withTask = false
    props = { record: ref, writer, platform: 'webchat', fileTransfer: true }
    const files = ['image/png', 'application/pdf'].map((mimeType, index) => ({
      uploadId: crypto.randomUUID(),
      name: index ? 'report.pdf' : 'shot.png',
      mimeType,
      size: 20,
      sha256: 'A'.repeat(43) + '='
    }))
    wire.drafts.ses_coordinator = 'Root draft'
    wire.files['ses_coordinator#post-root'] = files.map((attachment) => ({
      key: attachment.uploadId,
      name: attachment.name,
      size: attachment.size,
      status: 'ready',
      attachment
    }))
    await render()
    expect(container.querySelector('input[type="file"]')?.hasAttribute('multiple')).toBe(true)
    act(() =>
      container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    expect(wire.calls).toContain('thread:ses_coordinator:agent_1::post-root:conv-1')
    expect(wire.sentFiles).toEqual([files])
    expect(wire.files['ses_coordinator#post-root']).toEqual([])
    expect(wire.drafts.ses_coordinator).toBe('Root draft')
  })

  it('writes in an unowned thread on the conversation’s socket and shows only that thread’s live steps', async () => {
    wire.record = recordPage()
    withTask = false
    props = { record: ref, writer, focusComposer: true }
    wire.live = [
      step({ kind: 'msg', who: '@you', text: 'is it the lockfile?', thread: 'post-root' }),
      step({ kind: 'done', text: 'Checking the lockfile.', thread: 'post-root' }),
      step({ kind: 'msg', who: '@you', text: 'something else entirely', turnId: 't2', thread: 'post-other' }),
      step({ kind: 'done', text: 'An answer at the root', turnId: 't3' })
    ]
    // A message sends only what is drafted when the composer draws.
    wire.drafts['ses_coordinator#post-root'] = 'and the cache key?'
    await render()
    const panel = container.querySelector('[data-thread-panel="post-root"]')!
    const box = panel.querySelector<HTMLTextAreaElement>('[data-thread-composer]')!
    expect(box.getAttribute('placeholder')).toBe('Reply in the thread')
    expect(panel.querySelector('[data-task-thread-hint]')).toBeNull()
    expect(panel.querySelector('[data-task-thread-attach]')).not.toBeNull()
    // Reply in thread hands the caret to the box.
    expect(document.activeElement).toBe(box)
    expect(panel.textContent).toContain('is it the lockfile?')
    expect(panel.textContent).toContain('Checking the lockfile.')
    expect(panel.textContent).not.toContain('something else entirely')
    expect(panel.textContent).not.toContain('An answer at the root')

    act(() => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(wire.calls).toEqual(['thread:ses_coordinator:agent_1:and the cache key?:post-root:conv-1'])
    expect(wire.drafts['ses_coordinator#post-root']).toBe('')
  })

  it('writes in a held thread on the conversation’s socket too, which routing takes to the task', async () => {
    const summary = {
      rootId: 'post-root',
      replies: 2,
      participants: [],
      task: { sessionId: 'ses_task', title: 'Find what blocks api 1.5', state: 'open' },
      readable: true
    }
    wire.record = recordPage({ summary })
    withTask = false
    const seen: unknown[] = []
    props = { record: ref, writer, onSummary: (read) => seen.push(read) }
    // A message sends only what is drafted when the composer draws.
    wire.drafts['ses_coordinator#post-root'] = 'ship it'
    wire.busy = true
    wire.turnThread = 'post-root'
    await render()
    const panel = container.querySelector('[data-thread-panel="post-root"]')!
    expect(panel.getAttribute('data-task-thread')).toBe('ses_task')
    expect(panel.querySelector('[data-task-thread-hint]')).toBeNull()
    expect(panel.querySelector('[data-task-thread-attach]')).not.toBeNull()
    // The turn the owner sent in this thread is running.
    expect(panel.textContent).toContain('deploy-bot is working…')
    expect(seen).toEqual([summary])

    act(() => {
      panel
        .querySelector<HTMLTextAreaElement>('textarea')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(wire.calls).toEqual(['thread:ses_coordinator:agent_1:ship it:post-root:conv-1'])
  })

  it('is not busy for a turn the owner sent in another thread', async () => {
    wire.record = recordPage()
    withTask = false
    props = { record: ref, writer }
    wire.busy = true
    wire.turnThread = 'post-other'
    await render()
    expect(container.textContent).not.toContain('is working')
  })

  it('takes no message in a thread the owner cannot read', async () => {
    wire.record = recordPage({
      messages: [],
      summary: { rootId: 'post-root', replies: 1, participants: [], task: { state: 'open' }, readable: false }
    })
    withTask = false
    props = { record: ref, writer }
    await render()
    expect(container.querySelector('[data-thread-unreadable]')).not.toBeNull()
    expect(container.querySelector('textarea')).toBeNull()
  })
})
