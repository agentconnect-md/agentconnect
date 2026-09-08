/**
 * Telegram's elicitation card — the second implementer of the Layer-2 elicitation-card facet
 * (issue #1794, gap 6). An inline keyboard is the only control Telegram has, so the two kinds one
 * TAP answers are offered and every other kind is declined with the notice #1819/#1839 post.
 */
import { describe, it, expect, vi } from 'vitest'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { Daemon } from '../src/daemon.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { TelegramConnection, type InlineButton } from '../src/telegram/connection.js'
import { elicitForm, elicitOptionToken, elicitTarget } from '../src/slack/render.js'
import {
  TELEGRAM_ELICIT_SURFACE,
  parseTelegramElicit,
  telegramElicitButtons,
  telegramElicitData,
  telegramElicitDataFits,
  telegramElicitCards
} from '../src/platforms/telegram/elicit-card.js'

const REQUEST_ID = '11111111-2222-4333-8444-555555555555'

function form(properties: Record<string, unknown>, required: string[] = []): CreateElicitationRequest {
  return {
    sessionId: 's1',
    mode: 'form',
    message: 'Which branch should I cut from?',
    requestedSchema: { type: 'object', properties, required }
  } as CreateElicitationRequest
}

const BRANCH = { branch: { type: 'string', enum: ['main', 'develop'], title: 'Base branch' } }

describe("the wire a Telegram tap comes back on — 64 bytes, so it carries the option's position", () => {
  it("fits Telegram's own callback_data cap for the widest card this scheme can mint", () => {
    // Verified live against the Bot API: 64 bytes is accepted and 65 is BUTTON_DATA_INVALID.
    expect(Buffer.byteLength(telegramElicitData(REQUEST_ID, elicitOptionToken(23)), 'utf8')).toBeLessThanOrEqual(64)
    expect(telegramElicitDataFits(REQUEST_ID, 24)).toBe(true)
    // A request id long enough to blow the cap costs the card, rather than minting buttons the
    // API would refuse the whole message for.
    expect(telegramElicitDataFits('x'.repeat(120), 2)).toBe(false)
  })

  it('round-trips a position, reads Dismiss as no answer, and ignores every other scheme', () => {
    expect(parseTelegramElicit(telegramElicitData(REQUEST_ID, elicitOptionToken(3)))).toEqual({
      requestId: REQUEST_ID,
      token: elicitOptionToken(3)
    })
    expect(parseTelegramElicit(telegramElicitData(REQUEST_ID, 'x'))).toEqual({ requestId: REQUEST_ID, token: null })
    // The session-control cards' own scheme, which this decoder must never claim.
    expect(parseTelegramElicit('m:2')).toBeNull()
    expect(parseTelegramElicit('ac_el:only-two-parts')).toBeNull()
    expect(parseTelegramElicit('')).toBeNull()
  })

  it('carries one button per option plus Dismiss, each holding a POSITION and never a value', () => {
    const rows = telegramElicitButtons(REQUEST_ID, [{ label: 'main' }, { label: 'develop' }])
    expect(rows.map((r) => (r[0] as InlineButton).text)).toEqual(['main', 'develop', 'Dismiss'])
    expect(rows.map((r) => (r[0] as InlineButton).callbackData)).toEqual([
      telegramElicitData(REQUEST_ID, elicitOptionToken(0)),
      telegramElicitData(REQUEST_ID, elicitOptionToken(1)),
      telegramElicitData(REQUEST_ID, 'x')
    ])
  })
})

describe('what Telegram declares it can collect, and what it declines', () => {
  it('claims exactly the two kinds one tap answers', () => {
    expect([...TELEGRAM_ELICIT_SURFACE.kinds].sort()).toEqual(['boolean', 'enum'])
  })

  it('reduces an enum and a boolean, and nothing that has to be filled in first', () => {
    expect(elicitTarget(form(BRANCH), TELEGRAM_ELICIT_SURFACE)?.kind).toBe('enum')
    expect(elicitTarget(form({ ok: { type: 'boolean' } }), TELEGRAM_ELICIT_SURFACE)?.kind).toBe('boolean')
    for (const prop of [
      { checks: { type: 'array', items: { type: 'string', enum: ['lint', 'test'] } } },
      { note: { type: 'string' } },
      { count: { type: 'integer' } }
    ])
      expect(elicitForm(form(prop, Object.keys(prop)), TELEGRAM_ELICIT_SURFACE)).toBeNull()
  })

  it('declines an option list past what one keyboard holds, rather than showing part of it', () => {
    const many = (n: number) => ({ pick: { type: 'string', enum: Array.from({ length: n }, (_, i) => `o${i}`) } })
    expect(elicitForm(form(many(24)), TELEGRAM_ELICIT_SURFACE)).not.toBeNull()
    expect(elicitForm(form(many(25)), TELEGRAM_ELICIT_SURFACE)).toBeNull()
  })

  it('builds nothing for a URL consent, a multi-field form, or an optionless field', () => {
    const host = { postCardSerialized: async () => undefined, sessionTarget: () => undefined, turnState: () => ({}) }
    const turn = { plan: { platform: 'telegram', channel: '-100', statusThread: 'T', agentName: 'a' } }
    const ask = { requestId: REQUEST_ID, params: form(BRANCH), message: 'q', fallback: 'q' }
    // URL mode: an inline `url` button fires no callback_query, so a consent could never be recorded.
    expect(
      telegramElicitCards.build(host, turn, { ...ask, url: { elicitationId: 'e1', url: 'https://x.example' } })
    ).toBeNull()
    expect(telegramElicitCards.build(host, turn, ask)).toBeNull()
    const two = form({ ...BRANCH, also: { type: 'string', enum: ['a', 'b'] } })
    expect(
      telegramElicitCards.build(host, turn, {
        ...ask,
        params: two,
        form: elicitForm(two, TELEGRAM_ELICIT_SURFACE) ?? undefined
      })
    ).toBeNull()
  })
})

// ── the coordinator, on a Telegram turn ──────────────────────────────────────────────────────

interface Harness {
  daemon: any
  conn: any
  cards: { text: string; buttons: InlineButton[][]; opts: { threadTs?: string; replyTo?: number } }[]
  edits: { text: string; buttons: InlineButton[][] }[]
  acked: string[]
  notices: () => string[]
}

/** @param turn the turn's THREAD coordinate and its Telegram reply anchor — a plain supergroup
 *   session is `tg:<root>` (non-numeric, so it is no forum topic) and anchors by `replyTo`. */
function telegramTurn(turn: { thread?: string; replyTo?: number } = {}): Harness {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: () => new Map(),
    upsertElicit: vi.fn(async () => {})
  }
  const cards: { text: string; buttons: InlineButton[][]; opts: { threadTs?: string; replyTo?: number } }[] = []
  const edits: { text: string; buttons: InlineButton[][] }[] = []
  const acked: string[] = []
  const conn = Object.create(TelegramConnection.prototype)
  conn.postCard = async (
    _c: string,
    text: string,
    buttons: InlineButton[][],
    opts: { threadTs?: string; replyTo?: number } = {}
  ) => {
    cards.push({ text, buttons, opts })
    return '4242'
  }
  conn.editCard = async (_c: string, _id: number, text: string, buttons: InlineButton[][]) => {
    edits.push({ text, buttons })
  }
  conn.answerCallback = async (id: string) => void acked.push(id)
  daemon.pending.set(JSON.stringify(['agent-1', 's1']), {
    plan: {
      platform: 'telegram',
      agentId: 'agent-1',
      sessionKey: 'k1',
      requesterId: 'turn-user',
      channel: '-100',
      transcriptChannel: '-100',
      statusThread: 'T1',
      agentName: 'agent',
      isDm: false,
      approvalSurfaceSuppressed: false,
      ...(turn.thread !== undefined ? { thread: turn.thread } : {})
    },
    hostKey: 'agent-1',
    outwardSessionId: 'sess-1',
    conn,
    // §7.3's opaque per-turn slot, seeded exactly as `initialTurnState` seeds it.
    turnState: { ...(turn.replyTo !== undefined ? { replyTo: turn.replyTo } : {}) },
    chrome: {},
    reply: { text: '', attemptText: '', attemptAnswerUpdates: [] },
    signals: { applyChain: Promise.resolve() },
    approval: { waitMs: 0, depth: 0 },
    builtinSystemToolCallIds: new Set<string>(),
    conv: { onUpdate: () => [], hasBuffered: () => false },
    rec: { onUpdate: () => [] },
    termOut: new TerminalOutputFolder()
  })
  const applied: any[] = []
  daemon.enqueueApply = (_p: any, action: any) => void applied.push(action)
  return {
    daemon,
    conn,
    cards,
    edits,
    acked,
    notices: () => applied.filter((a) => a.kind === 'notice').map((a) => a.text as string)
  }
}

async function raise(h: Harness, req: CreateElicitationRequest): Promise<{ requestId: string; result: Promise<any> }> {
  const result = h.daemon.permissions.onAcpElicit('agent-1', 's1', req)
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.size).toBe(1))
  const requestId = [...h.daemon.permissions.pendingElicits.keys()][0] as string
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.get(requestId).ts).toBe('4242'))
  return { requestId, result }
}

describe('a Telegram turn posts an elicitation card and settles it in place', () => {
  it('posts the question with one button per option, and accepts the tapped position', async () => {
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form(BRANCH, ['branch']))
    expect(h.notices()).toEqual([])
    expect(h.cards).toHaveLength(1)
    expect(h.cards[0]!.text).toBe('💬 Which branch should I cut from?')
    expect(h.cards[0]!.buttons.map((r) => r[0]!.text)).toEqual(['main', 'develop', 'Dismiss'])

    await h.daemon.permissions.handleElicitChoice({ requestId, value: elicitOptionToken(1) })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    // The rewrite drops the keyboard and marks the answer with Telegram's own emoji, never a
    // Slack shortcode — a `:white_check_mark:` would reach the reader as its own source text.
    expect(h.edits).toHaveLength(1)
    expect(h.edits[0]!.text).toBe('💬 Which branch should I cut from?\n✅ develop')
    expect(h.edits[0]!.buttons).toEqual([])
  })

  it("reads Dismiss as the spec's decline, and settles the card as dismissed", async () => {
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form(BRANCH, ['branch']))
    await h.daemon.permissions.handleElicitChoice({ requestId, value: null })
    await expect(result).resolves.toEqual({ action: 'decline' })
    expect(h.edits[0]!.text).toContain('🚫 Dismissed')
  })

  it('refuses a position no option on the card held, and leaves the card live', async () => {
    const h = telegramTurn()
    const { requestId } = await raise(h, form(BRANCH, ['branch']))
    await h.daemon.permissions.handleElicitChoice({ requestId, value: elicitOptionToken(9) })
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    expect(h.edits).toEqual([])
    expect(h.notices()).toEqual(["That answer wasn't accepted — the question is still open."])
  })

  it('routes a tapped button through the callback the connection reports, and acks it', async () => {
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form(BRANCH, ['branch']))
    await h.daemon.handleTelegramCallback(
      {
        id: 'cb-1',
        data: telegramElicitData(requestId, elicitOptionToken(0)),
        channel: '-100',
        messageId: 4242,
        userId: '77'
      },
      h.conn
    )
    expect(h.acked).toEqual(['cb-1'])
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })
  })

  it('declines a kind Telegram has no control for, and says so in the chat', async () => {
    const h = telegramTurn()
    const req = form({ checks: { type: 'array', items: { type: 'string', enum: ['lint', 'test'] } } }, ['checks'])
    await expect(h.daemon.permissions.onAcpElicit('agent-1', 's1', req)).resolves.toBeUndefined()
    expect(h.cards).toEqual([])
    expect(h.notices()[0]).toContain("this chat can't collect an answer for")
  })

  // review-bot P2 on #1853. `postCard` only turns a NUMERIC thread into `message_thread_id`, so
  // off a forum `threadTs` anchors nothing: a `tg:<root>` supergroup card would land at the chat
  // root, and a reader replying to it would root a FRESH reply chain on the card rather than
  // continue this session — which the card's transcript row cannot repair, since its ts is
  // synthetic. The anchor is the turn's own state slot, the one `applyTelegramAction` reads.
  it('anchors the card to the turn on a non-forum session, where the thread is no anchor', async () => {
    const h = telegramTurn({ thread: 'tg:100', replyTo: 100 })
    await raise(h, form(BRANCH, ['branch']))
    expect(h.cards[0]!.opts.replyTo).toBe(100)
    expect(h.cards[0]!.opts.threadTs).toBe('tg:100')
  })

  it('still posts a forum-topic card into its topic, which IS an anchor', async () => {
    const h = telegramTurn({ thread: '77', replyTo: 512 })
    await raise(h, form(BRANCH, ['branch']))
    expect(h.cards[0]!.opts.threadTs).toBe('77')
    expect(h.cards[0]!.opts.replyTo).toBe(512)
  })

  // review-bot P2 on #1853. The question reserve only holds while the DECISION is bounded too,
  // and core's is not: a scalar's decision is `String(answer)`, and an enum option's value can be
  // a long URL. The edit runs AFTER ACP accepted and the pending record went, so a rewrite refused
  // for length can never be retried — the card would keep offering buttons that answer nothing.
  it('keeps a settlement inside the message limit when the answer is a long value', async () => {
    const h = telegramTurn()
    // The reviewer's own numbers: a question long enough to hit the reserve (so the card is the
    // full 3,799) plus a 621-character option value, which used to assemble to 4,423.
    const url = `https://auth.example.com/callback?${'q'.repeat(587)}`
    expect(url).toHaveLength(621)
    const req = form(
      {
        pick: { type: 'string', oneOf: [{ const: url, title: 'Choose URL' }], title: 'Destination' }
      },
      ['pick']
    )
    ;(req as { message?: string }).message = 'Q'.repeat(4000)
    const { requestId, result } = await raise(h, req)
    // The ask itself already fits: the question is clamped with the settlement line reserved.
    expect(h.cards[0]!.text.length).toBeLessThanOrEqual(4096)

    await h.daemon.permissions.handleElicitChoice({ requestId, value: elicitOptionToken(0) })
    // What the AGENT receives is the WHOLE value — #1844's rule: the reader's view is clamped,
    // the accepted content never is.
    await expect(result).resolves.toEqual({ action: 'accept', content: { pick: url } })
    expect(h.edits).toHaveLength(1)
    expect(h.edits[0]!.text.length).toBeLessThanOrEqual(4096)
    // And the verdict SURVIVES the clamp — a settlement whose mark got cut off would be a card
    // that still reads as open, which is the failure this guards against.
    expect(h.edits[0]!.text).toContain('✅')
  })

  it('cancels an abandoned card and says so on the card itself', async () => {
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form(BRANCH, ['branch']))
    await h.daemon.permissions.releaseElicits('agent-1', 's1')
    await expect(result).resolves.toEqual({ action: 'cancel' })
    expect(h.edits[0]!.text).toContain('⏳ Cancelled')
    expect(h.daemon.permissions.pendingElicits.has(requestId)).toBe(false)
  })
})
