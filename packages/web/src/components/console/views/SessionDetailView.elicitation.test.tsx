// @vitest-environment happy-dom

// The agent's in-band elicitation card on the real session page (#1794 gap 5). What matters is
// that the question stands in the conversation with answerable buttons, that the answer goes out
// on the webchat socket, and that a settled card collapses to its outcome for every reader.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Session } from '@/lib/data'

const wire = vi.hoisted(() => ({ messages: [] as unknown[] }))
const live = vi.hoisted(() => ({ steps: [] as unknown[], answered: [] as unknown[] }))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'session-1' }),
  usePathname: () => '/acme/sessions/session-1',
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({
    replace: () => {},
    push: () => {},
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {}
  })
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchSessionMessages: vi.fn(() => Promise.resolve({ messages: wire.messages, nextCursor: null })),
    fetchSessionDetail: vi.fn(() => Promise.reject(new Error('no detail'))),
    fetchMySessionIdentity: vi.fn(() => Promise.reject(new Error('no identity'))),
    fetchConversationByKey: vi.fn(() => Promise.reject(new Error('no conversation'))),
    fetchAgentTasks: vi.fn(() =>
      Promise.resolve({ sessionId: 'session-1', tracked: true, tasks: [], truncated: false })
    ),
    fetchSessionPullRequest: vi.fn(() => Promise.reject(new actual.ApiError('pull request not found', 404))),
    fetchWorkspaceFiles: vi.fn((_agentId: string, opts: { path: string }) =>
      Promise.resolve({ path: opts.path, exists: true, entries: [], nextCursor: null })
    ),
    fetchWorkspaceGitStatus: vi.fn(() => Promise.resolve({ isRepo: false })),
    fetchWorkspaceGitLog: vi.fn(() => Promise.resolve({ isRepo: false, commits: [], truncated: false, tracking: null }))
  }
})

const agent = {
  id: 'agent-1',
  name: 'Ops bot',
  runtime: 'claude',
  model: 'sonnet',
  status: 'online',
  statusLabel: 'online',
  icon: 'bot',
  daemon: 'daemon-1',
  workdir: './services/api',
  workspace: { mode: 'scratch' },
  canEdit: false
} as unknown as Agent

const session = {
  id: 'session-1',
  title: 'Upgrade the node',
  status: 'idle',
  statusLabel: 'completed',
  platform: 'webchat',
  channel: 'Playground',
  channelId: 'conv-1',
  user: 'sam',
  agentId: 'agent-1',
  agentName: 'Ops bot',
  // Empty, which is what puts the page on the REAL transcript (`wantTranscript`) instead of
  // the mock step list a list-only session carries.
  steps: []
} as unknown as Session

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [agent],
    allSessions: [session],
    getSessions: () => [session],
    sessionsLoading: false,
    crons: [],
    daemons: [],
    members: [],
    sessionActivityVersionById: {},
    sessionStreamGeneration: 0,
    revalidateSessionLists: () => {}
  })
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({
    activeOrg: { id: 'org-1', slug: 'acme' },
    myRole: 'collaborator',
    orgPath: (p: string) => `/acme${p}`
  })
}))

vi.mock('@/lib/profile', () => ({ useProfile: () => ({ user: { name: 'Sam' }, me: null }) }))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))
vi.mock('@/lib/stick-to-bottom', () => ({ useStickToBottom: () => () => {} }))
vi.mock('@/lib/auth', () => ({ isAuthConfigured: () => false }))
vi.mock('@/lib/use-session-list', () => ({
  useSessionList: () => ({ sessions: [], total: 0, isLoading: false, nextCursor: null, loadingMore: false })
}))

vi.mock('@/components/console/Shell', () => ({
  useCrumbSlot: () => ({ register: () => {} }),
  useMobileActionSlot: () => ({ action: null, register: () => {} })
}))

// One frozen object, not a fresh one per render: the transcript effect keys on
// `reconcileLiveSteps` by identity, so a new closure each render refetches, re-renders, and
// spins forever. (The viewer suite never sees this — its session carries mock steps, which
// turns the real transcript off.)
vi.mock('@/components/console/PlaygroundProvider', () => {
  const playground = {
    getPgSession: () => undefined,
    getLiveSteps: () => live.steps,
    getBusyLaneAgentIds: () => [],
    reconcileLiveSteps: () => {},
    getPgImage: () => null,
    getPgWorktree: () => false,
    isPgBusy: () => false,
    setPgImage: () => {},
    openPlayground: () => 'pg_new',
    pgSend: () => {},
    pgAttach: () => {},
    getPgQueue: () => [],
    pgCancelQueued: () => {},
    pgAddAgent: () => {},
    pgSetModel: () => {},
    pgSetEffort: () => {},
    pgSetPermissionPreset: () => {},
    pgSetFast: () => {},
    pgSetWorktree: () => {},
    pgCancel: () => {},
    pgAnswerElicitation: (...args: unknown[]) => live.answered.push(args),
    setPgInput: () => {}
  }
  return { usePlayground: () => playground, usePgDraft: () => '', usePgDraftHasText: () => false }
})

import SessionDetailView from './SessionDetailView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

const CARD = {
  kind: 'elicit',
  turnId: 'turn-1',
  agentId: 'agent-1',
  boundary: true,
  text: 'Which branch should I cut from?',
  elicit: {
    requestId: 'elicit-1',
    options: [
      { value: 'main', label: 'main' },
      { value: 'develop', label: 'develop' }
    ]
  }
}

async function render() {
  await act(async () => {
    root?.render(<SessionDetailView />)
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const text = () => container?.textContent ?? ''
const buttonNamed = (label: string) =>
  [...(container?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label)

beforeEach(() => {
  wire.messages = []
  live.steps = [CARD]
  live.answered = []
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
})

describe('the agent’s elicitation card on the session page', () => {
  it('asks its question with every option answerable, and sends the tapped choice', async () => {
    await render()

    expect(text()).toContain('Which branch should I cut from?')
    for (const label of ['main', 'develop', 'Dismiss']) expect(buttonNamed(label)?.disabled).toBe(false)

    await act(async () => {
      buttonNamed('develop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // The card's own agent answers, over this conversation's socket.
    expect(live.answered).toEqual([['session-1', 'agent-1', 'elicit-1', 'develop', 'conv-1']])

    await act(async () => {
      buttonNamed('Dismiss')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Dismiss is an explicit null, never an absent value.
    expect(live.answered[1]).toEqual(['session-1', 'agent-1', 'elicit-1', null, 'conv-1'])
  })

  it('toggles a multi-select and answers with the list only on Confirm', async () => {
    live.steps = [
      { ...CARD, text: 'Which checks should I run?', elicit: { ...CARD.elicit, multi: { minItems: 1, maxItems: 2 } } }
    ]
    await render()

    // Nothing picked yet, so there is nothing valid to confirm.
    expect(text()).toContain('Select 1–2')
    expect(buttonNamed('Confirm')?.disabled).toBe(true)

    await act(async () => {
      buttonNamed('main')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // A toggle is not an answer: the option is held, not sent.
    expect(live.answered).toEqual([])
    expect(buttonNamed('main')?.getAttribute('aria-pressed')).toBe('true')
    expect(buttonNamed('Confirm')?.disabled).toBe(false)

    await act(async () => {
      buttonNamed('develop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      buttonNamed('main')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(buttonNamed('main')?.getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      buttonNamed('Confirm')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(live.answered).toEqual([['session-1', 'agent-1', 'elicit-1', ['develop'], 'conv-1']])
  })

  it('stops offering picks the card would have to refuse, and confirms an empty unbounded set', async () => {
    live.steps = [{ ...CARD, elicit: { ...CARD.elicit, multi: { maxItems: 1 } } }]
    await render()

    // No minimum: "none of them" is an answer this card accepts from the start.
    expect(text()).toContain('Select up to 1')
    expect(buttonNamed('Confirm')?.disabled).toBe(false)

    await act(async () => {
      buttonNamed('main')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // At the cap the unpicked option goes inert; the picked one still un-picks.
    expect(buttonNamed('develop')?.disabled).toBe(true)
    expect(buttonNamed('main')?.disabled).toBe(false)

    await act(async () => {
      buttonNamed('Confirm')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(live.answered).toEqual([['session-1', 'agent-1', 'elicit-1', ['main'], 'conv-1']])
  })

  it('keeps a single-choice card answering on the tap, with no confirm to press', async () => {
    await render()
    expect(buttonNamed('Confirm')).toBeUndefined()
  })

  // ── free text and numbers (#1794 gap 3): a typed field has no options to offer ──

  const input = () => container?.querySelector('input[aria-label="Your answer"]') as HTMLInputElement | null
  const type = async (value: string) => {
    const field = input()!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('types a free-text answer and sends it only once its constraints are met', async () => {
    live.steps = [
      {
        ...CARD,
        text: 'What should I name the branch?',
        elicit: { requestId: 'elicit-1', options: [], text: { minLength: 3, pattern: '^[a-z-]+$' } }
      }
    ]
    await render()

    // Nothing typed yet, so there is nothing valid to submit — and the reason says why.
    expect(buttonNamed('Submit')?.disabled).toBe(true)
    expect(text()).toContain('Enter at least 3 characters')
    // A typed field offers nothing to pick.
    expect(buttonNamed('main')).toBeUndefined()

    await type('ab')
    expect(buttonNamed('Submit')?.disabled).toBe(true)
    await type('ADD')
    // Long enough now, but the schema's own pattern still refuses it.
    expect(buttonNamed('Submit')?.disabled).toBe(true)
    expect(text()).toContain('^[a-z-]+$')
    expect(live.answered).toEqual([])

    await type('add-retries')
    expect(buttonNamed('Submit')?.disabled).toBe(false)
    await act(async () => {
      buttonNamed('Submit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(live.answered).toEqual([['session-1', 'agent-1', 'elicit-1', 'add-retries', 'conv-1']])
  })

  // The validator runs during render, so a draft that merely LOOKS like a date used to take
  // the whole session view down with a RangeError instead of showing the correction hint.
  it('holds an impossible calendar draft without taking the view down with it', async () => {
    live.steps = [
      {
        ...CARD,
        text: 'When should I schedule it?',
        elicit: { requestId: 'elicit-1', options: [], text: { format: 'date' } }
      }
    ]
    await render()

    await type('2025-13-01')
    expect(buttonNamed('Submit')?.disabled).toBe(true)
    expect(text()).toContain('Enter a date as YYYY-MM-DD')
    expect(live.answered).toEqual([])

    await type('2025-01-31')
    expect(buttonNamed('Submit')?.disabled).toBe(false)
  })

  it('sends a numeric answer as a real number, and holds one outside the schema’s bounds', async () => {
    live.steps = [
      {
        ...CARD,
        text: 'How many retries?',
        elicit: { requestId: 'elicit-1', options: [], number: { integer: true, minimum: 1, maximum: 5 } }
      }
    ]
    await render()

    await type('9')
    expect(buttonNamed('Submit')?.disabled).toBe(true)
    expect(text()).toContain('Enter 5 or less')
    await type('2.5')
    expect(buttonNamed('Submit')?.disabled).toBe(true)
    expect(text()).toContain('Enter a whole number')

    await type('3')
    await act(async () => {
      buttonNamed('Submit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // A number, not the string that spelled it — the accepted content carries the schema's type.
    expect(live.answered).toEqual([['session-1', 'agent-1', 'elicit-1', 3, 'conv-1']])
  })

  it('pre-populates every kind from the schema default', async () => {
    live.steps = [
      { ...CARD, elicit: { requestId: 'elicit-1', options: [], text: { format: 'email' }, defaultValue: 'a@b.co' } }
    ]
    await render()
    // Pre-populated AND already valid, so the reader can simply accept the suggestion.
    expect(input()?.value).toBe('a@b.co')
    expect(buttonNamed('Submit')?.disabled).toBe(false)

    // A distinct card each time: a card's control is seeded when it arrives, not re-seeded.
    live.steps = [{ ...CARD, elicit: { ...CARD.elicit, requestId: 'elicit-2', defaultValue: 'develop' } }]
    await render()
    // A single-choice default stays marked, so the reader sees what the agent suggested.
    expect(buttonNamed('develop')?.getAttribute('aria-pressed')).toBe(null)
    expect(buttonNamed('develop')?.className).toContain('--brand')

    live.steps = [
      { ...CARD, elicit: { ...CARD.elicit, requestId: 'elicit-3', multi: { minItems: 1 }, defaultValue: ['main'] } }
    ]
    await render()
    expect(buttonNamed('main')?.getAttribute('aria-pressed')).toBe('true')
    expect(buttonNamed('Confirm')?.disabled).toBe(false)
    await act(async () => {
      buttonNamed('Confirm')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(live.answered.at(-1)).toEqual(['session-1', 'agent-1', 'elicit-3', ['main'], 'conv-1'])
  })

  // ── multi-field forms (#1794 gap 1): one control per field, one submit ──

  const inputNamed = (label: string) =>
    container?.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null
  const typeInto = async (field: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const FORM_FIELDS = [
    {
      propName: 'branch',
      label: 'Base branch',
      kind: 'enum',
      required: true,
      options: [
        { value: 'main', label: 'main' },
        { value: 'develop', label: 'develop' }
      ]
    },
    { propName: 'note', label: 'Note', kind: 'text', options: [], text: { maxLength: 6 } },
    {
      propName: 'force',
      label: 'Force push',
      kind: 'boolean',
      required: true,
      options: [
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' }
      ]
    }
  ]

  it('asks every field, labelled, behind one submit that waits for all of them', async () => {
    live.steps = [
      { ...CARD, text: 'Cut a branch', elicit: { requestId: 'elicit-1', options: [], fields: FORM_FIELDS } }
    ]
    await render()

    // Every field is named, and the one the schema does not require says so.
    for (const label of ['Base branch', 'Note', 'Force push']) expect(text()).toContain(label)
    expect(text()).toContain('(optional)')
    // Two required fields unanswered, so there is nothing valid to submit yet.
    expect(buttonNamed('Submit')?.disabled).toBe(true)
    expect(text()).toContain('Choose one')

    await act(async () => {
      buttonNamed('main')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // A pick is held, not sent: a form answers once, on Submit.
    expect(live.answered).toEqual([])
    expect(buttonNamed('main')?.getAttribute('aria-pressed')).toBe('true')
    expect(buttonNamed('Submit')?.disabled).toBe(true)

    await act(async () => {
      buttonNamed('No')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(buttonNamed('Submit')?.disabled).toBe(false)

    // One bad OPTIONAL field is still enough to hold the whole answer, with its own reason.
    await typeInto(inputNamed('Note')!, 'far too long')
    expect(text()).toContain('Enter at most 6 characters')
    expect(buttonNamed('Submit')?.disabled).toBe(true)

    await typeInto(inputNamed('Note')!, 'ok')
    expect(buttonNamed('Submit')?.disabled).toBe(false)
    await act(async () => {
      buttonNamed('Submit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // One value per field, each in the shape its own kind answers with.
    expect(live.answered).toEqual([
      ['session-1', 'agent-1', 'elicit-1', { branch: 'main', note: 'ok', force: 'false' }, 'conv-1']
    ])
  })

  it('leaves an untouched optional field out of the record entirely', async () => {
    live.steps = [
      {
        ...CARD,
        text: 'Cut a branch',
        elicit: {
          requestId: 'elicit-1',
          options: [],
          fields: [
            FORM_FIELDS[0],
            FORM_FIELDS[1],
            { propName: 'checks', label: 'Checks', kind: 'multi-enum', options: [{ value: 'lint', label: 'lint' }] }
          ]
        }
      }
    ]
    await render()

    // Nothing required but the pick, so the form is answerable with the rest left alone.
    await act(async () => {
      buttonNamed('main')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(buttonNamed('Submit')?.disabled).toBe(false)
    await act(async () => {
      buttonNamed('Submit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(live.answered).toEqual([['session-1', 'agent-1', 'elicit-1', { branch: 'main' }, 'conv-1']])

    // Dismiss stays an explicit refusal, not an empty record.
    await act(async () => {
      buttonNamed('Dismiss')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(live.answered[1]).toEqual(['session-1', 'agent-1', 'elicit-1', null, 'conv-1'])
  })

  it('pre-populates each field of a form from its own schema default', async () => {
    live.steps = [
      {
        ...CARD,
        elicit: {
          requestId: 'elicit-1',
          options: [],
          fields: [
            { ...FORM_FIELDS[0], defaultValue: 'develop' },
            { ...FORM_FIELDS[1], required: true, defaultValue: 'seed' }
          ]
        }
      }
    ]
    await render()

    expect(inputNamed('Note')?.value).toBe('seed')
    expect(buttonNamed('develop')?.getAttribute('aria-pressed')).toBe('true')
    // Seeded AND already valid, so the reader can simply accept what the agent suggested.
    expect(buttonNamed('Submit')?.disabled).toBe(false)
    await act(async () => {
      buttonNamed('Submit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(live.answered).toEqual([['session-1', 'agent-1', 'elicit-1', { branch: 'develop', note: 'seed' }, 'conv-1']])
  })

  it('collapses to its outcome once settled, leaving nothing left to answer', async () => {
    live.steps = [{ ...CARD, elicit: { ...CARD.elicit, outcome: 'accepted', answerLabel: 'develop' } }]
    await render()

    expect(text()).toContain('Which branch should I cut from?')
    expect(text()).toContain('develop')
    expect(buttonNamed('main')).toBeUndefined()
    expect(buttonNamed('Dismiss')).toBeUndefined()
    expect(live.answered).toEqual([])
  })

  it('names a turn-end cancellation rather than showing a card nobody can answer', async () => {
    live.steps = [{ ...CARD, elicit: { ...CARD.elicit, outcome: 'cancelled' } }]
    await render()

    expect(text()).toContain('Cancelled')
    expect(buttonNamed('main')).toBeUndefined()
  })
})

// URL mode (#1794 gap 4). Credentials, OAuth and payment take this seam precisely so the page
// never reaches the model, the card, or the Control Plane — so what is asserted here is as much
// about what the console does NOT do as about what it renders.
describe('the agent’s URL-mode consent card', () => {
  const URL_CARD = {
    ...CARD,
    text: 'Sign in to the billing provider to continue',
    elicit: { requestId: 'elicit-9', options: [] as { value: string; label: string }[], url: '' }
  }
  const urlCard = (url: string) => [{ ...URL_CARD, elicit: { ...URL_CARD.elicit, url } }]
  const linkNamed = (label: string) =>
    [...(container?.querySelectorAll('a') ?? [])].find((a) => a.textContent === label)

  it('shows the full URL and opens it in a new tab only on an explicit click', async () => {
    const url = 'https://billing.example.com/oauth/authorize?client_id=abc123&scope=read+write'
    live.steps = urlCard(url)
    await render()

    // The whole URL, unshortened and unelided — there is nothing to examine otherwise.
    expect(text()).toContain(url)
    const open = linkNamed('Open link')
    expect(open?.getAttribute('href')).toBe(url)
    // A real browser tab: never an iframe or an in-app webview, and no referrer carried over.
    expect(open?.getAttribute('target')).toBe('_blank')
    expect(open?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(container?.querySelector('iframe')).toBeNull()
    // Nothing has been consented to until the reader acts.
    expect(live.answered).toEqual([])

    // Cancel the default so the test runner does not actually open the tab; React's own
    // handler still runs, which is the consent this asserts.
    const stop = (e: Event) => e.preventDefault()
    document.addEventListener('click', stop)
    await act(async () => {
      open?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    document.removeEventListener('click', stop)
    // Consent is the card's own URL back — the one value this card offers.
    expect(live.answered).toEqual([['session-1', 'agent-1', 'elicit-9', url, 'conv-1']])
  })

  it('never fetches the URL or any metadata about it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    live.steps = urlCard('https://billing.example.com/oauth/authorize')
    await render()

    // No page fetch, no favicon, no title lookup, no preview.
    for (const call of fetchSpy.mock.calls) expect(String(call[0])).not.toContain('billing.example.com')
    // And no markup that would make the browser reach for it on our behalf.
    expect(container?.querySelector('link[rel~="prefetch"], link[rel~="preload"], link[rel~="preconnect"]')).toBeNull()
    for (const el of container?.querySelectorAll('img, script, iframe') ?? [])
      expect(el.getAttribute('src') ?? '').not.toContain('billing.example.com')
    fetchSpy.mockRestore()
  })

  it('flags a Punycode host, which is how a lookalike domain spells itself', async () => {
    live.steps = urlCard('https://xn--80ak6aa92e.example-login.com/authorize')
    await render()

    expect(text()).toContain('not plain ASCII')
    // The full URL is still shown, and the card is still answerable — the warning is advisory.
    expect(text()).toContain('xn--80ak6aa92e.example-login.com')
    expect(linkNamed('Open link')).toBeDefined()
  })

  // The parser lowercases an uppercase host and punycodes a Unicode one, so neither spelling
  // occurs in the original string. Searching it for the normalized host found nothing and left
  // a card with no URL and no way to consent, for requests the daemon had already accepted.
  it('shows the URL and offers Open for hosts the parser would rewrite', async () => {
    live.steps = urlCard('https://Billing.EXAMPLE.com/Pay?t=1')
    await render()
    expect(text()).toContain('Billing.EXAMPLE.com')
    expect(linkNamed('Open link')?.getAttribute('href')).toBe('https://Billing.EXAMPLE.com/Pay?t=1')

    live.steps = urlCard('https://例え.jp/authorize')
    await render()
    // Shown as the reader sees it, warned about as what it resolves to.
    expect(text()).toContain('例え.jp')
    expect(text()).toContain('not plain ASCII')
    expect(linkNamed('Open link')).toBeDefined()
  })

  it('calls out a link that is not encrypted', async () => {
    live.steps = urlCard('http://billing.example.com/pay')
    await render()

    expect(text()).toContain('Not encrypted (http)')
  })

  it('leaves an https host unflagged', async () => {
    live.steps = urlCard('https://billing.example.com/pay')
    await render()

    expect(text()).not.toContain('not plain ASCII')
    expect(text()).not.toContain('Not encrypted')
  })

  it('offers nothing to open for a scheme a browser tab must never be handed', async () => {
    live.steps = urlCard('javascript:alert(1)')
    await render()

    // The daemon already refuses these; the card refuses again rather than trust the wire.
    expect(linkNamed('Open link')).toBeUndefined()
    expect(container?.querySelector('a[href^="javascript:"]')).toBeNull()
  })

  it('reads Declined at refusal and Completed once the agent reports the flow finished', async () => {
    live.steps = urlCard('https://billing.example.com/pay')
    await render()

    await act(async () => {
      buttonNamed('Decline')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // An explicit refusal is a null answer, the same shape every other card dismisses with.
    expect(live.answered).toEqual([['session-1', 'agent-1', 'elicit-9', null, 'conv-1']])

    live.steps = [{ ...URL_CARD, elicit: { ...URL_CARD.elicit, url: 'https://x.test/a', outcome: 'completed' } }]
    await render()
    expect(text()).toContain('Completed')
    expect(linkNamed('Open link')).toBeUndefined()
  })

  it('renders no clickable URL for a FORM-mode elicitation that mentions one', async () => {
    live.steps = [{ ...CARD, text: 'Paste the token from https://billing.example.com/tokens' }]
    await render()

    // Only URL mode may send the reader anywhere — a form's message is text, and stays text.
    expect(text()).toContain('https://billing.example.com/tokens')
    for (const a of container?.querySelectorAll('a') ?? [])
      expect(a.getAttribute('href') ?? '').not.toContain('billing.example.com')
  })
})
