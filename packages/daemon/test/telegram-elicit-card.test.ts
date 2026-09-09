/**
 * Telegram's elicitation card — the second implementer of the Layer-2 elicitation-card facet
 * (issue #1794, gap 6). An inline keyboard is the only control Telegram has, so a multi-select is
 * ASSEMBLED out of it: checkbox buttons that toggle and redraw, and a Confirm that submits the set
 * through the same re-derivation a Slack Confirm goes through. A typed box has no keyboard
 * equivalent at all, so `text`/`number` — and any form carrying one — are still declined with the
 * notice #1819/#1839 post.
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
  telegramElicitCheckboxes,
  telegramElicitData,
  telegramElicitFormText,
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

const CHECKS = { checks: { type: 'array', items: { type: 'string', enum: ['lint', 'test', 'build'] } } }

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
  it('claims every kind a keyboard can answer, a typed one included', () => {
    expect([...TELEGRAM_ELICIT_SURFACE.kinds].sort()).toEqual(['boolean', 'enum', 'multi-enum', 'number', 'text'])
  })

  it('reduces each kind to the control that collects it', () => {
    expect(elicitTarget(form(BRANCH), TELEGRAM_ELICIT_SURFACE)?.kind).toBe('enum')
    expect(elicitTarget(form({ ok: { type: 'boolean' } }), TELEGRAM_ELICIT_SURFACE)?.kind).toBe('boolean')
    expect(elicitTarget(form(CHECKS), TELEGRAM_ELICIT_SURFACE)?.kind).toBe('multi-enum')
    expect(elicitTarget(form({ note: { type: 'string' } }), TELEGRAM_ELICIT_SURFACE)?.kind).toBe('text')
    expect(elicitTarget(form({ count: { type: 'integer' } }), TELEGRAM_ELICIT_SURFACE)?.kind).toBe('number')
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

describe('the checkbox keyboard a multi-select is assembled on', () => {
  it('carries one ticked-or-blank button per option, then Confirm and Dismiss', () => {
    const rows = telegramElicitCheckboxes(REQUEST_ID, [{ label: 'lint' }, { label: 'test' }], new Set([1]))
    expect(rows.slice(0, 2).map((r) => (r[0] as InlineButton).text)).toEqual(['⬜️ lint', '☑️ test'])
    expect(rows[2]!.map((b) => b.text)).toEqual(['Confirm', 'Dismiss'])
    // Every option button still carries its POSITION, never its value — the 64-byte cap is why.
    expect(rows.slice(0, 2).map((r) => (r[0] as InlineButton).callbackData)).toEqual([
      telegramElicitData(REQUEST_ID, elicitOptionToken(0)),
      telegramElicitData(REQUEST_ID, elicitOptionToken(1))
    ])
    expect(rows[2]!.map((b) => b.callbackData)).toEqual([
      telegramElicitData(REQUEST_ID, 'ok'),
      telegramElicitData(REQUEST_ID, 'x')
    ])
  })
})

// ── the coordinator, on a Telegram turn ──────────────────────────────────────────────────────

interface Harness {
  daemon: any
  conn: any
  cards: { text: string; buttons: InlineButton[][]; opts: { threadTs?: string; replyTo?: number } }[]
  edits: { text: string; buttons: InlineButton[][]; id?: number }[]
  acked: string[]
  notices: () => string[]
  /** Hold the next card post's response, so a tap can be made to beat its own send. */
  holdPost: (release: Promise<void>) => void
  prompts: { text: string; opts: { replyTo?: number; placeholder?: string } }[]
  deleted: string[]
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
  const edits: { text: string; buttons: InlineButton[][]; id?: number }[] = []
  const prompts: { text: string; opts: { replyTo?: number; placeholder?: string } }[] = []
  const deleted: string[] = []
  const acked: string[] = []
  const conn = Object.create(TelegramConnection.prototype)
  let held: Promise<void> | undefined
  conn.postCard = async (
    _c: string,
    text: string,
    buttons: InlineButton[][],
    opts: { threadTs?: string; replyTo?: number } = {}
  ) => {
    cards.push({ text, buttons, opts })
    if (held) await held
    return '4242'
  }
  conn.editCard = async (_c: string, id: number, text: string, buttons: InlineButton[][]) => {
    edits.push({ text, buttons, id })
  }
  // A DISTINCT id per send, as Telegram gives: a fixed one hides a card holding two open boxes.
  conn.postPrompt = async (_c: string, text: string, opts: { replyTo?: number; placeholder?: string } = {}) => {
    prompts.push({ text, opts })
    return String(5150 + prompts.length - 1)
  }
  conn.deleteMessage = async (_c: string, ts: string) => {
    deleted.push(ts)
    return true
  }
  conn.answerCallback = async (id: string) => void acked.push(id)
  daemon.pending.set(JSON.stringify(['agent-1', 's1']), {
    plan: {
      platform: 'telegram',
      agentId: 'agent-1',
      sessionKey: 'k1',
      requesterId: 'turn-user',
      channel: '-100',
      transcriptChannel: '-100\u001ftelegram:bot-a',
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
    notices: () => applied.filter((a) => a.kind === 'notice').map((a) => a.text as string),
    holdPost: (release: Promise<void>) => void (held = release),
    prompts,
    deleted
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

  it('declines an ask Telegram has no card for, and says so in the chat', async () => {
    const h = telegramTurn()
    // Several questions: one prompt at a time is a state machine across fields, and a reader who
    // walks away mid-way leaves half a form standing.
    const req = form({ note: { type: 'string' }, count: { type: 'integer' } }, ['note', 'count'])
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

describe('a Telegram multi-select is assembled on the keyboard and submitted by Confirm', () => {
  async function tap(h: Harness, requestId: string, token: string): Promise<void> {
    await h.daemon.handleTelegramCallback(
      { id: `cb-${token}`, data: telegramElicitData(requestId, token), channel: '-100', messageId: 4242, userId: '77' },
      h.conn
    )
  }

  it('posts checkboxes, toggles one on and off in place, and accepts the Confirmed set', async () => {
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form(CHECKS, ['checks']))
    expect(h.notices()).toEqual([])
    expect(h.cards[0]!.buttons.map((r) => r[0]!.text)).toEqual(['⬜️ lint', '⬜️ test', '⬜️ build', 'Confirm'])

    await tap(h, requestId, elicitOptionToken(0))
    await tap(h, requestId, elicitOptionToken(2))
    await tap(h, requestId, elicitOptionToken(0))
    await tap(h, requestId, elicitOptionToken(1))
    // Each tap redraws the same message; the card is still open, nothing has been answered yet.
    expect(h.edits).toHaveLength(4)
    expect(h.edits[3]!.buttons.map((r) => r[0]!.text)).toEqual(['⬜️ lint', '☑️ test', '☑️ build', 'Confirm'])
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)

    await tap(h, requestId, 'ok')
    // The ticks come back as the LIST the schema asked for, in the card's own option order.
    await expect(result).resolves.toEqual({ action: 'accept', content: { checks: ['test', 'build'] } })
    expect(h.edits.at(-1)!.text).toBe('💬 Which branch should I cut from?\n✅ checks: test, build')
    expect(h.edits.at(-1)!.buttons).toEqual([])
  })

  it('says on the card what the keyboard cannot enforce — the selection bounds', async () => {
    const h = telegramTurn()
    const bounded = { checks: { ...CHECKS.checks, minItems: 2 } }
    const { requestId } = await raise(h, form(bounded, ['checks']))
    expect(h.cards[0]!.text).toBe('💬 Which branch should I cut from?\nSelect at least 2.')

    // And a Confirm that breaks them is refused with the field's own words, card still live.
    await tap(h, requestId, elicitOptionToken(0))
    await tap(h, requestId, 'ok')
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    expect(h.notices().at(-1)).toContain('Select at least 2.')
  })

  it('Confirms an untouched optional multi-select as an omission, not as an empty answer', async () => {
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form(CHECKS))
    await tap(h, requestId, 'ok')
    await expect(result).resolves.toEqual({ action: 'accept', content: {} })
  })

  it('reads Dismiss on an assembled card as the decline it is on every other card', async () => {
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form(CHECKS, ['checks']))
    await tap(h, requestId, elicitOptionToken(1))
    await tap(h, requestId, 'x')
    await expect(result).resolves.toEqual({ action: 'decline' })
    expect(h.edits.at(-1)!.text).toContain('🚫 Dismissed')
  })

  it("redraws a card tapped before its own post reported an id, from the tap's own message", async () => {
    // A reader can tap the instant Telegram shows the keyboard, which can beat the send that
    // records the card's id — the tick must still reach the boxes the reader is looking at.
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form(CHECKS, ['checks']))
    const rec = h.daemon.permissions.pendingElicits.get(requestId)
    rec.ts = undefined
    // The adoption is synchronous, so the state under test survives to the fold.
    await h.daemon.permissions.handleElicitCardTap({ requestId, token: elicitOptionToken(0), ts: '4242' })

    expect(rec.ts).toBe('4242')
    expect(h.edits.at(-1)!.buttons.map((r) => r[0]!.text)).toEqual(['☑️ lint', '⬜️ test', '⬜️ build', 'Confirm'])
    await tap(h, requestId, 'ok')
    await expect(result).resolves.toEqual({ action: 'accept', content: { checks: ['lint'] } })
  })

  it('keeps the answer on a card Confirmed before its own post returned', async () => {
    // The tap carries the card's id, so the settlement rewrites it AS ANSWERED while the send is
    // still in flight; the posting path must not then call that same card Cancelled.
    const h = telegramTurn()
    let release!: () => void
    h.holdPost(new Promise<void>((r) => (release = r)))
    const result = h.daemon.permissions.onAcpElicit('agent-1', 's1', form(CHECKS, ['checks']))
    await vi.waitFor(() => expect(h.cards).toHaveLength(1))
    const requestId = [...h.daemon.permissions.pendingElicits.keys()][0] as string

    await tap(h, requestId, elicitOptionToken(0))
    await tap(h, requestId, 'ok')
    expect(h.daemon.permissions.pendingElicits.size).toBe(0)
    // Only now does the post report its id, and the posting path finds the card already settled.
    release()
    await expect(result).resolves.toEqual({ action: 'accept', content: { checks: ['lint'] } })

    expect(h.edits.at(-1)!.text).toContain('✅ checks: lint')
    expect(h.edits.map((e) => e.text).some((t) => t.includes('Cancelled'))).toBe(false)
  })

  it('refuses a tick it cannot show at all, rather than remembering one the boxes deny', () => {
    const params = form(CHECKS, ['checks'])
    const fields = elicitForm(params, TELEGRAM_ELICIT_SURFACE)!
    const handle: any = { conn: {}, channel: '-100' }
    expect(
      telegramElicitCards.tap!(handle, { requestId: REQUEST_ID, params, form: fields }, elicitOptionToken(0))
    ).toBe(null)
    expect([...(handle.cardState?.chosen ?? [])]).toEqual([])
  })

  it('keeps a long question and its whole hint inside one Telegram message', () => {
    // A hint runs to 2000 characters and the limit is 4096, so appending one to an already-clamped
    // question would refuse the post outright — and a refused post is no card at all.
    const target = {
      propName: 'checks',
      kind: 'multi-enum' as const,
      options: [{ value: 'lint', label: 'lint' }],
      description: 'd'.repeat(300),
      minItems: 1
    }
    const text = telegramElicitFormText('q'.repeat(4000), target)
    expect([...text].length).toBeLessThanOrEqual(4096)
    // The question yields, never the hint: the bounds are what the keyboard cannot say itself.
    expect(text).toContain('Select at least 1.')
  })

  it('refuses a position no checkbox on the card held, and leaves the card live', async () => {
    const h = telegramTurn()
    const { requestId } = await raise(h, form(CHECKS, ['checks']))
    await tap(h, requestId, elicitOptionToken(9))
    expect(h.edits).toEqual([])
    expect(h.notices()).toEqual(["That answer wasn't accepted — the question is still open."])
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
  })
})

describe('a Telegram typed answer is written into a force-reply box', () => {
  async function tap(h: Harness, requestId: string, token: string): Promise<void> {
    await h.daemon.handleTelegramCallback(
      { id: `cb-${token}`, data: telegramElicitData(requestId, token), channel: '-100', messageId: 4242, userId: '77' },
      h.conn
    )
  }
  const CONV = '-100\u001ftelegram:bot-a'
  const reply = (text: string, replyTo?: string, conversation = CONV) => ({
    conversation,
    text,
    ...(replyTo ? { replyTo } : {})
  })

  it('offers a box rather than a control that cannot take characters, and takes what is typed', async () => {
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form({ note: { type: 'string' } }, ['note']))
    expect(h.cards[0]!.buttons).toEqual([
      [
        { text: 'Answer', callbackData: telegramElicitData(requestId, 'ed') },
        { text: 'Dismiss', callbackData: telegramElicitData(requestId, 'x') }
      ]
    ])
    // Opening the box is not an answer: the card is exactly as open as it was.
    await tap(h, requestId, 'ed')
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    // The prompt REPLIES to the card, which is also what keeps it inside a forum topic.
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]!.opts.replyTo).toBe(4242)

    expect(await h.daemon.permissions.claimElicitReply(reply('ship it', '5150'))).toBe(true)
    await expect(result).resolves.toEqual({ action: 'accept', content: { note: 'ship it' } })
    // The card stops offering anything, and the prompt is DELETED rather than edited: Telegram
    // edits only a message carrying no markup or an inline keyboard, so an edit aimed at a
    // `force_reply` is refused and the box would simply remain.
    expect(h.edits.map((e) => e.id)).toEqual([4242])
    expect(h.edits[0]!.text).toContain('✅ note: ship it')
    expect(h.deleted).toEqual(['5150'])
  })

  it('answers only the prompt it opened — never a reply to anything else', async () => {
    const h = telegramTurn()
    const { requestId } = await raise(h, form({ note: { type: 'string' } }, ['note']))
    // Before the box is even asked for, nothing in this chat is an answer.
    expect(await h.daemon.permissions.claimElicitReply(reply('ship it', '5150'))).toBe(false)
    await tap(h, requestId, 'ed')
    // A message that replies to nothing, and one replying to some other message, are both prompts.
    expect(await h.daemon.permissions.claimElicitReply(reply('ship it'))).toBe(false)
    expect(await h.daemon.permissions.claimElicitReply(reply('ship it', '4242'))).toBe(false)
    // Another conversation's reply cannot reach this card, and neither can the SAME chat id
    // reached through a different bot — one person's DMs with two bots share their message
    // numbers, so the bot is part of the identity.
    expect(await h.daemon.permissions.claimElicitReply(reply('x', '5150', '-200\u001ftelegram:bot-a'))).toBe(false)
    expect(await h.daemon.permissions.claimElicitReply(reply('x', '5150', '-100\u001ftelegram:bot-b'))).toBe(false)
    expect(await h.daemon.permissions.claimElicitReply(reply('x', '5150', '-100'))).toBe(false)
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
  })

  it('keeps EVERY box it opened answerable, so a second tap does not break the first', async () => {
    // Two readers can be typing at once, and one reader can tap twice. A box still on screen must
    // not have stopped working because a later one appeared.
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form({ note: { type: 'string' } }, ['note']))
    await tap(h, requestId, 'ed')
    await tap(h, requestId, 'ed')
    expect(h.prompts).toHaveLength(2)
    expect(await h.daemon.permissions.claimElicitReply(reply('from the first box', '5150'))).toBe(true)
    await expect(result).resolves.toEqual({ action: 'accept', content: { note: 'from the first box' } })
    // And both boxes are retired, not just the one that was answered.
    expect(h.deleted.sort()).toEqual(['5150', '5151'])
  })

  it('takes the first answer and nothing after it, because the answered card is gone', async () => {
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form({ note: { type: 'string' } }, ['note']))
    await tap(h, requestId, 'ed')
    expect(await h.daemon.permissions.claimElicitReply(reply('first', '5150'))).toBe(true)
    expect(await h.daemon.permissions.claimElicitReply(reply('second', '5150'))).toBe(false)
    await expect(result).resolves.toEqual({ action: 'accept', content: { note: 'first' } })
  })

  it('keeps the SAME box open after a refusal, so the retry goes where the reader is typing', async () => {
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form({ count: { type: 'integer' } }, ['count']))
    await tap(h, requestId, 'ed')
    expect(await h.daemon.permissions.claimElicitReply(reply('nope', '5150'))).toBe(true)
    expect(h.prompts).toHaveLength(1)
    expect(await h.daemon.permissions.claimElicitReply(reply('7', '5150'))).toBe(true)
    await expect(result).resolves.toEqual({ action: 'accept', content: { count: 7 } })
  })

  it('gives a number field a real number, and refuses words with the field’s own message', async () => {
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form({ count: { type: 'integer', minimum: 1 } }, ['count']))
    await tap(h, requestId, 'ed')
    expect(await h.daemon.permissions.claimElicitReply(reply('not a number', '5150'))).toBe(true)
    // Claimed but refused: the words were an answer to THIS card, and a bad one leaves it live.
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    expect(h.notices().at(-1)).toContain('Enter')

    expect(await h.daemon.permissions.claimElicitReply(reply('42', '5150'))).toBe(true)
    await expect(result).resolves.toEqual({ action: 'accept', content: { count: 42 } })
  })

  it('still reads Dismiss as the decline it is on every card', async () => {
    const h = telegramTurn()
    const { requestId, result } = await raise(h, form({ note: { type: 'string' } }, ['note']))
    await tap(h, requestId, 'ed')
    await tap(h, requestId, 'x')
    await expect(result).resolves.toEqual({ action: 'decline' })
    expect(h.edits[0]!.text).toContain('🚫 Dismissed')
  })
})
