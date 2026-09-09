/**
 * The daemon's own ask (session-visibility.md §5.1): a private session's memory write waits for
 * the human in that session. It rides the elicitation machinery as one synthetic three-way card,
 * so the surfaces, the answer validation, and turn cancellation are all the existing ones.
 */
import { describe, expect, it, vi } from 'vitest'
import { agentHostKey } from '../src/acp/host-key.js'
import { PermissionCoordinator, type PermissionHost } from '../src/permissions/coordinator.js'
import {
  MEMORY_WRITE_APPROVAL_OPTIONS,
  memoryWriteApprovalElicitation,
  memoryWriteApprovalFrom
} from '../src/permissions/memory-write-approval.js'
import type { ElicitCardFacet } from '../src/platforms/elicit-card.js'
import { elicitOptionToken, SLACK_ELICIT_SURFACE } from '../src/slack/render.js'
import { pendingTurnKey, type Pending } from '../src/daemon/turn-types.js'
import type { MemoryWriteAsk } from '../src/mcp/ops/memory.js'

const AGENT = 'bot-a'
const OWNER = agentHostKey(AGENT)
const ACP_SESSION = 'acp-1'
const ASK: MemoryWriteAsk = { tool: 'writeMemory', target: 'deploys.md', summary: 'Content: "- ship on Fridays"' }
const LABELS = ['Allow once', 'Allow for this session', 'Deny']

interface WorldOptions {
  platform?: string
  webchat?: boolean
  headless?: boolean
  callMeta?: boolean
  channel?: string
  conn?: boolean
  facet?: ElicitCardFacet
  suppressed?: boolean
}

function world(over: WorldOptions = {}) {
  const store = {
    getSessionByAcpIdForAgent: async () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: async () => new Map<string, string>(),
    createPermissionRequest: vi.fn(async () => {}),
    resolvePermissionRequest: vi.fn(async () => true),
    clearPermissionRequestNotify: vi.fn(async () => {}),
    upsertElicit: vi.fn(async () => {})
  }
  const sink = { output: vi.fn(), done: vi.fn() }
  const webchat = over.webchat ?? true
  const p = {
    plan: {
      sessionKey: 'sess-key',
      agentId: AGENT,
      agentName: 'Butler',
      platform: over.platform ?? 'webchat',
      channel: over.channel ?? 'conv-1',
      statusThread: 'conv-1',
      transcriptChannel: 'conv-1',
      requesterId: 'user-1',
      approvalSurfaceSuppressed: false
    },
    approval: { waitMs: 0, depth: 0 },
    acpSessionId: ACP_SESSION,
    hostKey: OWNER,
    outwardSessionId: 'outward-1',
    builtinSystemToolCallIds: new Set<string>(),
    entry: { msg: { text: 'please forget the deploy note', ...(over.headless ? { headless: true } : {}) } },
    ...(over.callMeta ? { callMeta: { callerAgentId: 'bot-b' } } : {}),
    ...(over.suppressed ? { outputSuppressed: 'paused' } : {}),
    ...(over.conn ? { conn: {} } : {}),
    ...(webchat
      ? {
          webchat: {
            conversationId: 'conv-1',
            turnId: 'turn-1',
            sink,
            index: 0,
            replyText: '',
            heldText: '',
            messageEmitted: false
          }
        }
      : {})
  } as unknown as Pending
  const pending = new Map<string, Pending>([[pendingTurnKey(OWNER, ACP_SESSION), p]])
  const enqueueApply = vi.fn()
  const host: PermissionHost = {
    log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as never,
    clock: () => ({ now: () => Date.now() }) as never,
    store: () => store as never,
    agents: () => new Map([[AGENT, { id: AGENT } as never]]),
    pending: () => pending,
    evalHooks: () => ({ emit: vi.fn() }) as never,
    memoryExtractionInFlight: () => false,
    enqueueApply,
    postCardSerialized: vi.fn(async () => undefined),
    elicitCardFacet: () => over.facet,
    httpSlackSessionTarget: () => undefined,
    maskAgentSecrets: (_agentId, payload) => payload,
    logSessionAction: vi.fn(),
    emitApprovalActivity: vi.fn(),
    approvalGateOpened: () => false,
    approvalGateClosed: vi.fn(),
    cpApprovalRoute: () => undefined,
    orgForAgent: () => 'org-1',
    sessionLink: (sessionId) => `https://console.example.test/sessions/${sessionId}`,
    slackConnFor: () => undefined,
    approvalDmIntegrations: () => [],
    slackDmSessionTarget: () => 'encoded-target'
  }
  const events = (): any[] => sink.output.mock.calls.map(([o]: any[]) => o.event)
  return { store, sink, events, enqueueApply, coordinator: new PermissionCoordinator(host), p }
}

/** Wait for the card to be streamed and hand back its request id. */
async function cardOf(w: ReturnType<typeof world>) {
  await vi.waitFor(() => expect(w.events().some((e) => e.kind === 'elicitation')).toBe(true))
  return w.events().find((e) => e.kind === 'elicitation')!
}

describe('the card a private webchat session is shown', () => {
  it('names the tool, the target and the content summary, and offers exactly the three choices', async () => {
    const w = world()
    const outcome = w.coordinator.askMemoryWriteApproval(OWNER, ACP_SESSION, ASK)
    const card = await cardOf(w)
    const [head, ...rest] = (card.message as string).split('\n')
    expect(head).toBe('Allow this write to shared agent memory from a private session?')
    expect(rest).toEqual(['writeMemory → deploys.md', 'Content: "- ship on Fridays"'])
    expect(card.options.map((o: { label: string }) => o.label)).toEqual(LABELS)
    expect(card.options.map((o: { value: string }) => o.value)).toEqual(['allow_once', 'allow_session', 'deny'])
    // The ask is durable transcript history like any other card (#1794).
    expect(w.store.upsertElicit).toHaveBeenCalledTimes(1)
    await w.coordinator.handleElicitChoice({
      requestId: card.requestId,
      value: 'allow_once',
      webchatConversationId: 'conv-1'
    })
    await expect(outcome).resolves.toBe('allow_once')
  })

  it('reads each choice back as its own outcome, Dismiss included', async () => {
    for (const [value, expected] of [
      ['allow_session', 'allow_session'],
      ['deny', 'denied'],
      [null, 'denied']
    ] as const) {
      const w = world()
      const outcome = w.coordinator.askMemoryWriteApproval(OWNER, ACP_SESSION, ASK)
      const card = await cardOf(w)
      await w.coordinator.handleElicitChoice({ requestId: card.requestId, value, webchatConversationId: 'conv-1' })
      await expect(outcome).resolves.toBe(expected)
      const resolved = w.events().find((e) => e.kind === 'elicitation_resolved')
      expect(resolved.outcome).toBe(value === null ? 'dismissed' : 'accepted')
    }
  })

  it('refuses an answer the card never offered and stays open, and an answer from another conversation', async () => {
    const w = world()
    const outcome = w.coordinator.askMemoryWriteApproval(OWNER, ACP_SESSION, ASK)
    const card = await cardOf(w)
    await w.coordinator.handleElicitChoice({
      requestId: card.requestId,
      value: 'allow_forever',
      webchatConversationId: 'conv-1'
    })
    await w.coordinator.handleElicitChoice({
      requestId: card.requestId,
      value: 'allow_once',
      webchatConversationId: 'conv-2'
    })
    expect(w.events().some((e) => e.kind === 'elicitation_resolved')).toBe(false)
    await w.coordinator.handleElicitChoice({
      requestId: card.requestId,
      value: 'deny',
      webchatConversationId: 'conv-1'
    })
    await expect(outcome).resolves.toBe('denied')
  })

  it('settles as a decline when the turn is cancelled, and the card says so', async () => {
    const w = world()
    const outcome = w.coordinator.askMemoryWriteApproval(OWNER, ACP_SESSION, ASK)
    const card = await cardOf(w)
    await w.coordinator.releaseElicits(OWNER, ACP_SESSION)
    await expect(outcome).resolves.toBe('denied')
    const resolved = w.events().find((e) => e.kind === 'elicitation_resolved')
    expect(resolved).toMatchObject({ requestId: card.requestId, outcome: 'cancelled' })
  })

  it('bills the wait to the turn as human-approval time', async () => {
    const w = world()
    const outcome = w.coordinator.askMemoryWriteApproval(OWNER, ACP_SESSION, ASK)
    const card = await cardOf(w)
    expect(w.p.approval.depth).toBe(1)
    await w.coordinator.handleElicitChoice({
      requestId: card.requestId,
      value: 'deny',
      webchatConversationId: 'conv-1'
    })
    await outcome
    expect(w.p.approval.depth).toBe(0)
  })
})

describe('a chat platform with an elicitation card', () => {
  const facet = () => {
    const sent: any[] = []
    const settle = vi.fn()
    const f = {
      reduction: SLACK_ELICIT_SURFACE,
      build: () => ({ draft: true }),
      send: async (_host: unknown, _turn: unknown, ask: unknown) => {
        sent.push(ask)
        return 'ts-1'
      },
      settle
    } as unknown as ElicitCardFacet
    return { f, sent, settle }
  }

  it('posts the three-button card there and reads a tapped POSITION back as the choice', async () => {
    const { f, sent, settle } = facet()
    const w = world({ platform: 'slack', webchat: false, conn: true, facet: f })
    const outcome = w.coordinator.askMemoryWriteApproval(OWNER, ACP_SESSION, ASK)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const ask = sent[0]
    expect(ask.message).toContain('writeMemory → deploys.md')
    expect(ask.form.map((t: { options: { label: string }[] }) => t.options.map((o) => o.label))).toEqual([LABELS])
    // Position 1 is "Allow for this session" — the card carries positions, never values (#1794).
    await w.coordinator.handleElicitChoice({
      requestId: ask.requestId,
      value: elicitOptionToken(1),
      actor: { userId: 'U1' }
    })
    await expect(outcome).resolves.toBe('allow_session')
    // The card settles the way every enum card does; the transcript row carries the label.
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle.mock.calls[0]![1]).toMatchObject({ mark: 'answered' })
    const rows = w.store.upsertElicit.mock.calls.map(([row]: any[]) => JSON.parse(row.body))
    expect(rows.at(-1)).toMatchObject({ outcome: 'accepted', answerLabel: 'Allow for this session' })
  })
})

describe('a chat with no card of its own takes the Agent-editor queue', () => {
  it('records the request with the target, and an editor Allow is one write', async () => {
    const w = world({ platform: 'discord', webchat: false, conn: true })
    const outcome = w.coordinator.askMemoryWriteApproval(OWNER, ACP_SESSION, ASK)
    await vi.waitFor(() => expect(w.store.createPermissionRequest).toHaveBeenCalledTimes(1))
    const row = (w.store.createPermissionRequest.mock.calls[0] as any[])[0]
    expect(row.command).toContain('deploys.md')
    // The channel hears the same neutral notice every editor-queued request posts.
    expect(w.enqueueApply.mock.calls[0]![1]).toMatchObject({ kind: 'notice' })
    await w.coordinator.decideEditorPermission({ requestId: row.id, agentId: AGENT, decision: 'allow' })
    await expect(outcome).resolves.toBe('allow_once')
  })

  it('an editor Deny, or the turn ending, is a decline', async () => {
    const denied = world({ platform: 'discord', webchat: false, conn: true })
    const first = denied.coordinator.askMemoryWriteApproval(OWNER, ACP_SESSION, ASK)
    await vi.waitFor(() => expect(denied.store.createPermissionRequest).toHaveBeenCalledTimes(1))
    const id = (denied.store.createPermissionRequest.mock.calls[0] as any[])[0].id as string
    await denied.coordinator.decideEditorPermission({ requestId: id, agentId: AGENT, decision: 'deny' })
    await expect(first).resolves.toBe('denied')

    const ended = world({ platform: 'discord', webchat: false, conn: true })
    const second = ended.coordinator.askMemoryWriteApproval(OWNER, ACP_SESSION, ASK)
    await vi.waitFor(() => expect(ended.store.createPermissionRequest).toHaveBeenCalledTimes(1))
    await ended.coordinator.releaseEditorPermissions(OWNER, ACP_SESSION)
    await expect(second).resolves.toBe('denied')
  })
})

describe('a turn with no human behind it is answered at once, never hung', () => {
  it.each([
    ['no live turn', () => world(), 'acp-other'],
    ['a suppressed turn', () => world({ suppressed: true }), ACP_SESSION],
    ['a headless run', () => world({ headless: true }), ACP_SESSION],
    ['an agent-to-agent child', () => world({ callMeta: true }), ACP_SESSION],
    ['a synthetic A2A channel', () => world({ channel: 'a2a:bot-b:bot-a' }), ACP_SESSION]
  ])('%s', async (_name, make, sessionId) => {
    const w = make()
    await expect(w.coordinator.askMemoryWriteApproval(OWNER, sessionId, ASK)).resolves.toBe('no_approver')
    expect(w.events()).toEqual([])
    expect(w.store.createPermissionRequest).not.toHaveBeenCalled()
  })
})

describe('the synthetic form and its answer, in isolation', () => {
  it('is one required single-select whose options are the three choices', () => {
    const params = memoryWriteApprovalElicitation('s1', ASK) as any
    expect(params.mode).toBe('form')
    expect(params.requestedSchema.required).toEqual(['decision'])
    expect(params.requestedSchema.properties.decision.oneOf.map((o: { title: string }) => o.title)).toEqual(LABELS)
    expect(MEMORY_WRITE_APPROVAL_OPTIONS.map((o) => o.label)).toEqual(LABELS)
  })

  it('reads a bare accept as one write and everything short of a grant as a decline', () => {
    expect(memoryWriteApprovalFrom({ action: 'accept' })).toBe('allow_once')
    expect(memoryWriteApprovalFrom({ action: 'accept', content: { decision: 'allow_session' } })).toBe('allow_session')
    expect(memoryWriteApprovalFrom({ action: 'accept', content: { decision: 'deny' } })).toBe('denied')
    expect(memoryWriteApprovalFrom({ action: 'decline' })).toBe('denied')
    expect(memoryWriteApprovalFrom({ action: 'cancel' })).toBe('denied')
    expect(memoryWriteApprovalFrom(undefined)).toBe('no_approver')
  })
})
