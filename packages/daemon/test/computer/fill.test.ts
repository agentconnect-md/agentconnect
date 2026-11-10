import { describe, expect, it, vi } from 'vitest'
import type { ComputerFillCard } from '@agentconnect.md/protocol/computer-form-fill'
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client'
import type { ComputerMcpConnection } from '../../src/computer/data-plane.js'
import { PendingFillCards, type FillCardAnswer } from '../../src/computer/fill-cards.js'
import {
  COMPUTER_FILL_TOOLS,
  COMPUTER_TOOLS,
  ComputerTools,
  type ComputerApprovalAsk
} from '../../src/computer/tools.js'
import type { SessionContext } from '../../src/mcp/ops.js'

const AGENT = '00000000-0000-4000-8000-0000000000bb'
const C1 = '00000000-0000-4000-8000-000000000001'
const T0 = Date.parse('2026-11-10T10:00:00.000Z')
const CANARY = 'canary-daemon-fill-5d1e'
const ORIGIN = 'https://login.example.test'

const ctx: SessionContext = {
  agentId: AGENT,
  platform: 'webchat',
  isDm: true,
  channel: 'c',
  thread: 't',
  deliveryThread: 't',
  tools: [...COMPUTER_TOOLS, ...COMPUTER_FILL_TOOLS]
}

const target = { tabId: 3, frameId: 0, documentId: 'D0', topOrigin: ORIGIN, frameOrigin: ORIGIN, formId: '0:form1' }
const fields = [
  { id: 'f1', control: 'text', purpose: 'username', label: 'Email', required: true, secret: false, empty: true },
  {
    id: 'f2',
    control: 'password',
    purpose: 'current-password',
    label: 'Password',
    required: true,
    secret: true,
    empty: true
  }
]
const found = {
  v: 1,
  status: 'found',
  tab: { tabId: 3, topOrigin: ORIGIN, title: 'Sign in' },
  target,
  forms: [{ id: '0:form1', kind: 'login', focused: true, frameOrigin: ORIGIN, frameId: 0, documentId: 'D0', fields }]
}
const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

function setup(options: {
  answer?: (card: ComputerFillCard) => Promise<FillCardAnswer | undefined>
  desktop?: (name: string, args: Record<string, unknown>) => Promise<unknown>
}) {
  const events: string[] = []
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const cards: ComputerFillCard[] = []
  const settled: Array<{ requestId: string; outcome: string }> = []
  const asks: ComputerApprovalAsk[] = []
  const leases = {
    computerLeaseAcquire: vi.fn(async () => {
      events.push('lease')
      return {
        granted: true as const,
        lease: {
          leaseId: '00000000-0000-4000-8000-0000000000ee',
          computerId: C1,
          holder: { sessionId: 'out-1', agentId: AGENT },
          acquiredAt: new Date(T0).toISOString(),
          expiresAt: new Date(T0 + 1_800_000).toISOString()
        }
      }
    }),
    computerLeaseRelease: vi.fn(async () => undefined)
  }
  const desktop =
    options.desktop ??
    (async (name: string, args: Record<string, unknown>) => {
      if (name === 'computer_form_discover') return text(found)
      if (name === 'computer_form_fill')
        return text({
          v: 1,
          requestId: args.requestId,
          status: 'filled',
          fields: [
            { field: 'f1', status: 'filled' },
            { field: 'f2', status: 'filled' }
          ],
          navigated: false
        })
      return text({})
    })
  const tools = new ComputerTools({
    grants: { computerChannelGrant: vi.fn() },
    leases,
    computersFor: () => [C1],
    orgFor: () => 'org_1',
    sessionIdFor: async () => 'out-1',
    now: () => T0,
    approver: {
      ask: async (_ctx, ask) => {
        events.push('approval')
        asks.push(ask)
        return 'allow'
      }
    },
    fillCards: {
      ask: async (_ctx, card) => {
        events.push('card')
        cards.push(card)
        return options.answer
          ? await options.answer(card)
          : {
              kind: 'submit',
              values: [
                { field: 'f1', value: 'ada@example.test' },
                { field: 'f2', value: CANARY }
              ],
              responder: 'user_1'
            }
      },
      settled: (_ctx, requestId, outcome) => settled.push({ requestId, outcome })
    },
    connect: async () =>
      ({
        client: {
          callTool: async (params: { name: string; arguments?: Record<string, unknown> }) => {
            calls.push({ name: params.name, args: params.arguments ?? {} })
            if (params.name === 'computer_form_fill') events.push('fill')
            return await desktop(params.name, params.arguments ?? {})
          }
        },
        channel: { grant: async () => ({ granted: true, name: 'Desk', approvals: { firstInputPerSession: true } }) },
        close: async () => undefined
      }) as unknown as ComputerMcpConnection
  })
  return { tools, events, calls, cards, settled, asks, leases }
}

const result = async (tools: ComputerTools, args: Record<string, unknown> = {}) => {
  const out = (await tools.call(ctx, 'computer_fill_form', args))!.result
  const body = out.mcpContent.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
  return { out, body, json: JSON.parse(body) as Record<string, unknown> }
}

describe('computer_fill_form (computer-form-fill-and-vault.md §5, §6)', () => {
  it('shows a value-free card, then approves, leases and fills only after the person answered', async () => {
    const h = setup({})
    const { out, body, json } = await result(h.tools, { reason: 'Sign in to open the report' })
    expect(h.events).toEqual(['card', 'approval', 'lease', 'fill'])
    expect(h.cards[0]).toMatchObject({
      computerName: 'Desk',
      website: { origin: ORIGIN, title: 'Sign in' },
      kind: 'login',
      fields,
      reason: 'Sign in to open the report',
      expiresAt: new Date(T0 + 10 * 60_000).toISOString()
    })
    expect(h.asks[0]).toMatchObject({ tool: 'computer_fill_form', action: `fill 2 form fields on ${ORIGIN}` })
    const fill = h.calls.find((call) => call.name === 'computer_form_fill')!
    expect(fill.args).toMatchObject({
      v: 1,
      target,
      values: [
        { field: 'f1', value: 'ada@example.test' },
        { field: 'f2', value: CANARY }
      ]
    })
    expect(out.mcpIsError).toBeUndefined()
    expect(json).toMatchObject({
      status: 'filled',
      website: ORIGIN,
      form: { id: '0:form1', kind: 'login' },
      fields: [
        { id: 'f1', label: 'Email', purpose: 'username', status: 'filled' },
        { id: 'f2', label: 'Password', purpose: 'current-password', status: 'filled' }
      ],
      navigated: false
    })
    expect(body).not.toContain(CANARY)
    expect(body).not.toContain('ada@example.test')
    expect(h.settled).toEqual([{ requestId: h.cards[0]!.requestId, outcome: 'filled' }])
  })

  it('takes no lease and sends nothing when the person declines or nobody answers', async () => {
    for (const [answer, status] of [
      [{ kind: 'cancel' }, 'cancelled'],
      [{ kind: 'expired' }, 'expired'],
      [{ kind: 'stopped' }, 'expired']
    ] as const) {
      const h = setup({ answer: async () => answer })
      const { json } = await result(h.tools)
      expect(json.status).toBe(status)
      expect(h.leases.computerLeaseAcquire).not.toHaveBeenCalled()
      expect(h.calls.map((call) => call.name)).toEqual(['computer_form_discover'])
    }
  })

  it('lists the forms instead of asking when the page has several', async () => {
    const h = setup({
      desktop: async () =>
        text({
          ...found,
          status: 'ambiguous',
          target: undefined,
          forms: [found.forms[0], { ...found.forms[0], id: '0:page', kind: 'other' }]
        })
    })
    const { json } = await result(h.tools)
    expect(json).toMatchObject({
      status: 'ambiguous',
      forms: [
        { id: '0:form1', kind: 'login' },
        { id: '0:page', kind: 'other' }
      ]
    })
    expect(h.cards).toEqual([])
  })

  it('says a computer without form support cannot fill, before any card', async () => {
    const h = setup({
      desktop: async () => {
        throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Tool computer_form_discover not found')
      }
    })
    const { json } = await result(h.tools)
    expect(json.error).toBe('unsupported')
    expect(h.cards).toEqual([])
  })

  it('never resends a fill whose answer was lost, and settles it from the desktop’s stored result', async () => {
    let status: unknown = { v: 1, requestId: '', state: 'unknown' }
    const h = setup({
      desktop: async (name, args) => {
        if (name === 'computer_form_discover') return text(found)
        if (name === 'computer_form_fill') throw new Error('relay timed out')
        return text({ ...(status as object), requestId: args.requestId })
      }
    })
    const lost = await result(h.tools)
    expect(lost.json.status).toBe('uncertain')
    expect(lost.out.mcpIsError).toBe(true)
    expect(h.calls.filter((call) => call.name === 'computer_form_fill')).toHaveLength(1)
    expect(lost.body).not.toContain(CANARY)

    status = {
      v: 1,
      state: 'done',
      result: { v: 1, status: 'partial', fields: [{ field: 'f1', status: 'filled' }], navigated: true }
    }
    const h2 = setup({
      desktop: async (name, args) => {
        if (name === 'computer_form_discover') return text(found)
        if (name === 'computer_form_fill') throw new Error('relay timed out')
        const stored = status as { result: Record<string, unknown> }
        return text({ ...stored, requestId: args.requestId, result: { ...stored.result, requestId: args.requestId } })
      }
    })
    const recovered = await result(h2.tools)
    expect(recovered.json).toMatchObject({ status: 'partial', navigated: true })
  })

  it('refuses where the conversation cannot show a card', async () => {
    const h = setup({ answer: async () => undefined })
    expect((await result(h.tools)).json.error).toBe('unsupported')
    expect(h.leases.computerLeaseAcquire).not.toHaveBeenCalled()
  })
})

describe('PendingFillCards', () => {
  const card = (requestId: string, expiresAt = new Date(Date.now() + 60_000).toISOString()): ComputerFillCard => ({
    requestId,
    computerName: 'Desk',
    website: { origin: ORIGIN },
    kind: 'login',
    fields: fields as ComputerFillCard['fields'],
    expiresAt
  })
  const scope = { conversationId: 'conv-1', sessionId: 'out-1', agentId: AGENT, requester: { userId: 'user_1' } }
  const id = '7f9d6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f'

  it('takes an answer only from the asking person in the card’s conversation, with the card’s own fields', async () => {
    const pending = new PendingFillCards()
    const waiting = pending.wait(card(id), scope, () => true)
    expect(
      pending.answer({
        requestId: id,
        conversationId: 'conv-2',
        userId: 'user_1',
        values: [{ field: 'f1', value: 'x' }]
      })
    ).toMatchObject({ accepted: false })
    expect(
      pending.answer({
        requestId: id,
        conversationId: 'conv-1',
        userId: 'user_2',
        values: [{ field: 'f1', value: 'x' }]
      })
    ).toMatchObject({ accepted: false })
    expect(
      pending.answer({
        requestId: id,
        conversationId: 'conv-1',
        userId: 'user_1',
        values: [{ field: 'f9', value: 'x' }]
      })
    ).toMatchObject({ accepted: false })
    expect(pending.answer({ requestId: id, conversationId: 'conv-1', userId: 'user_1', values: [] })).toMatchObject({
      accepted: false
    })
    expect(
      pending.answer({
        requestId: id,
        conversationId: 'conv-1',
        userId: 'user_1',
        values: [{ field: 'f1', value: 'x' }]
      })
    ).toEqual({ accepted: true })
    expect(await waiting).toEqual({ kind: 'submit', values: [{ field: 'f1', value: 'x' }], responder: 'user_1' })
    expect(pending.answer({ requestId: id, conversationId: 'conv-1', userId: 'user_1', cancel: true })).toMatchObject({
      accepted: false
    })
    expect(pending.size()).toBe(0)
  })

  it('lets a console continuation of the session open and answer a chat-asked card, only for the member who asked', async () => {
    const pending = new PendingFillCards()
    const chat = { sessionId: 'out-7', agentId: AGENT, requester: { identity: 'slack:T1:U1' } }
    const shown = card(id)
    const waiting = pending.wait(shown, chat, () => true)
    const base = { requestId: id, conversationId: 'console-conv', targetSessionId: 'out-7', userId: 'user_9' }
    expect(pending.open({ ...base, userIdentities: ['slack:T1:U2'] })).toEqual({
      refused: 'only the person who asked can answer this Fill card'
    })
    expect(pending.open({ ...base, targetSessionId: 'out-8', userIdentities: ['slack:T1:U1'] })).toMatchObject({
      refused: expect.any(String)
    })
    expect(pending.open({ ...base, userIdentities: ['slack:T1:U1'] })).toEqual({ card: shown })
    expect(pending.answer({ ...base, userIdentities: ['slack:T1:U1'], cancel: true })).toEqual({ accepted: true })
    expect(await waiting).toEqual({ kind: 'cancel' })
  })

  it('refuses a card from a turn with no known person', async () => {
    const pending = new PendingFillCards()
    void pending.wait(card(id), { ...scope, requester: undefined }, () => true)
    expect(pending.answer({ requestId: id, conversationId: 'conv-1', userId: undefined, cancel: true })).toMatchObject({
      accepted: false
    })
    pending.stopConversation('conv-1')
  })

  it('expires, and stops when the turn ends or the conversation closes', async () => {
    vi.useFakeTimers()
    try {
      const pending = new PendingFillCards()
      const expiring = pending.wait(card(id, new Date(Date.now() + 5000).toISOString()), scope, () => true)
      await vi.advanceTimersByTimeAsync(5000)
      expect(await expiring).toEqual({ kind: 'expired' })
      let alive = true
      const stopping = pending.wait(card(id), scope, () => alive)
      alive = false
      await vi.advanceTimersByTimeAsync(1000)
      expect(await stopping).toEqual({ kind: 'stopped' })
      const closing = pending.wait(card(id), scope, () => true)
      pending.stopConversation('conv-1')
      expect(await closing).toEqual({ kind: 'stopped' })
    } finally {
      vi.useRealTimers()
    }
  })
})
