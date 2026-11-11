// WeCom's question cards: a template card answered by a tap, closed under the tap's req_id, else a numbered card answered by quote.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk/unstable'
import type { WeComInboundMessage } from '@agentconnect.md/message'
import { Daemon } from '../src/daemon.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { WorkBoundary } from '../src/messages/message-boundary.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { elicitForm, elicitOptionToken } from '../src/slack/render.js'
import { WECOM_CARD_UPDATE_WINDOW_MS, WeComConnection } from '../src/platforms/wecom/connection.js'
import {
  WECOM_CARD_QUESTION_CAP,
  WECOM_ELICIT_SURFACE,
  weComCardLayout,
  weComCardTap,
  weComElicitChoice,
  weComElicitText,
  weComQuestionCard,
  weComSettledCard
} from '../src/platforms/wecom/elicit-card.js'
import { WECOM_PER_HOUR } from '../src/platforms/wecom/rate-limit.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { FakeWeComServer, quietLog, type SentFrame } from './fakes/wecom-server.js'

const BOT = 'aibot-example'
const CHANNEL = 'chat-example-group'
const CONVERSATION = `${CHANNEL}\u001fwecom:${BOT}`
const REQ = '33333333-3333-4333-8333-333333333333'

function form(properties: Record<string, unknown>, required: string[] = []): CreateElicitationRequest {
  return {
    sessionId: 's1',
    mode: 'form',
    message: 'Which branch should I cut from?',
    requestedSchema: { type: 'object', properties, required }
  } as CreateElicitationRequest
}

const BRANCH = { branch: { type: 'string', enum: ['main', 'develop'], title: 'Base branch' } }
const BOOL = { proceed: { type: 'boolean', title: 'Proceed' } }
const enumOf = (n: number) => ({
  branch: { type: 'string', enum: Array.from({ length: n }, (_, i) => `b${i + 1}`), title: 'Base branch' }
})
const targetOf = (properties: Record<string, unknown>) =>
  elicitForm(form(properties, Object.keys(properties)), WECOM_ELICIT_SURFACE)![0]!

// A tap body as the connection receives it, in the doc's nested shape unless `flat` asks for the official SDK's.
function tapBody(taskId: string, key: string, extra: { selected?: unknown; flat?: boolean; userid?: string } = {}) {
  const data = { card_type: 'button_interaction', event_key: key, task_id: taskId, selected_items: extra.selected }
  return {
    msgid: 'event-0001',
    aibotid: BOT,
    chatid: CHANNEL,
    chattype: 'group',
    from: { userid: extra.userid ?? 'user-alice' },
    msgtype: 'event',
    event: extra.flat
      ? { eventtype: 'template_card_event', ...data }
      : { eventtype: 'template_card_event', template_card_event: data }
  }
}

const voted = (id: string) => ({ selected_item: [{ question_key: 'choice', option_ids: { option_id: [id] } }] })

describe('the WeCom question card', () => {
  it('lays out yes/no and up to six options as buttons, and up to twenty as a single-choice vote', () => {
    expect(weComCardLayout(targetOf(BOOL))).toBe('yesno')
    expect(weComCardLayout(targetOf(BRANCH))).toBe('buttons')
    expect(weComCardLayout(targetOf(enumOf(6)))).toBe('buttons')
    expect(weComCardLayout(targetOf(enumOf(7)))).toBe('vote')
    expect(weComCardLayout(targetOf(enumOf(20)))).toBe('vote')
    // Past twenty options the reduction declines the ask, as it does a typed one.
    expect(elicitForm(form(enumOf(21), ['branch']), WECOM_ELICIT_SURFACE)).toBeNull()
  })

  it('asks yes/no with two buttons whose keys are option positions', () => {
    const card = weComQuestionCard(REQ, 'Butler', 'Proceed?', targetOf(BOOL))!
    const labels = targetOf(BOOL).options.map((o) => o.label)
    expect(card).toEqual({
      taskId: `acq-y-${REQ}`,
      card: {
        card_type: 'button_interaction',
        main_title: { title: 'Butler' },
        sub_title_text: 'Proceed?',
        button_list: labels.map((text, i) => ({ text, key: `o${i}` })),
        task_id: `acq-y-${REQ}`
      }
    })
  })

  it('labels one button per option', () => {
    expect(weComQuestionCard(REQ, 'Butler', 'Which branch?', targetOf(BRANCH))).toEqual({
      taskId: `acq-b-${REQ}`,
      card: {
        card_type: 'button_interaction',
        main_title: { title: 'Butler' },
        sub_title_text: 'Which branch?',
        button_list: [
          { text: 'main', key: 'o0' },
          { text: 'develop', key: 'o1' }
        ],
        task_id: `acq-b-${REQ}`
      }
    })
  })

  it('asks seven or more options as a single-choice vote with a submit button', () => {
    const { taskId, card } = weComQuestionCard(REQ, 'Butler', 'Which branch?', targetOf(enumOf(7)))!
    expect(taskId).toBe(`acq-v-${REQ}`)
    expect(card).toEqual({
      card_type: 'vote_interaction',
      main_title: { title: 'Butler' },
      sub_title_text: 'Which branch?',
      checkbox: {
        question_key: 'choice',
        mode: 0,
        option_list: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, text: `b${i + 1}` }))
      },
      submit_button: { text: 'Submit', key: 'submit' },
      task_id: taskId
    })
  })

  it('leaves to the text card a question past the card text and options that clip to the same label', () => {
    const long = 'x'.repeat(WECOM_CARD_QUESTION_CAP + 1)
    expect(weComQuestionCard(REQ, 'Butler', long, targetOf(BRANCH))).toBeNull()
    const clash = {
      choice: { type: 'string', enum: ['a-very-long-option-name-one', 'a-very-long-option-name-two'], title: 'Pick' }
    }
    expect(weComQuestionCard(REQ, 'Butler', 'Which?', targetOf(clash))).toBeNull()
  })

  it('reads a button tap and a vote submit back to the option token, in both event shapes, and nothing it did not send', () => {
    const buttons = `acq-b-${REQ}`
    expect(weComCardTap(tapBody(buttons, 'o1'))).toEqual({
      taskId: buttons,
      requestId: REQ,
      token: elicitOptionToken(1),
      userId: 'user-alice'
    })
    expect(weComCardTap(tapBody(buttons, 'o0', { flat: true }))?.token).toBe(elicitOptionToken(0))
    const vote = `acq-v-${REQ}`
    expect(weComCardTap(tapBody(vote, 'submit', { selected: voted('o5') }))?.token).toBe(elicitOptionToken(5))
    expect(weComCardTap(tapBody(vote, 'submit'))?.token).toBeNull()
    expect(weComCardTap(tapBody(buttons, 'something-else'))?.token).toBeNull()
    expect(weComCardTap(tapBody('task-from-elsewhere', 'o0'))).toBeNull()
    expect(weComCardTap({ ...tapBody(buttons, 'o0'), from: {} })).toBeNull()
  })

  it('replaces a settled card with a text notice of the outcome and the question', () => {
    const settled = weComSettledCard(`acq-b-${REQ}`, {
      params: form(BRANCH),
      consent: false,
      mark: 'answered',
      text: 'develop'
    })
    expect(settled).toEqual({
      card_type: 'text_notice',
      main_title: { title: '✅ develop' },
      sub_title_text: 'Which branch should I cut from?',
      task_id: `acq-b-${REQ}`
    })
  })
})

describe('the WeCom text card and the replies it reads', () => {
  it('numbers every option and says to quote it, with its tag', () => {
    expect(weComElicitText('Which branch?', targetOf(BRANCH), CHANNEL, 'Q-0A1B2C3D')).toBe(
      [
        '💬 Which branch?',
        '',
        '1. main',
        '2. develop',
        '',
        'Quote this message and reply with a number, mentioning the bot. (Q-0A1B2C3D)'
      ].join('\n')
    )
    expect(weComElicitText('Which branch?', targetOf(BRANCH), 'dm:user-alice', 'Q-0A1B2C3D')).toContain(
      'Quote this message and reply with a number. (Q-0A1B2C3D)'
    )
  })

  it('reads a number, a full-width number, an option label, or either after a group mention, and nothing else', () => {
    const target = targetOf(BRANCH)
    expect(weComElicitChoice(target, '2')).toBe(1)
    expect(weComElicitChoice(target, '２')).toBe(1)
    expect(weComElicitChoice(target, 'Main')).toBe(0)
    expect(weComElicitChoice(target, '@Example Bot 2')).toBe(1)
    expect(weComElicitChoice(target, '@Example Bot develop')).toBe(1)
    expect(weComElicitChoice(target, '3')).toBeNull()
    expect(weComElicitChoice(target, 'maybe 2')).toBeNull()
    expect(weComElicitChoice(target, '@Example Bot maybe')).toBeNull()
  })
})

const connections: WeComConnection[] = []
afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.stop()
})

// A WeCom turn on a real connection to the fake server, its taps wired to core as the reconciler wires them.
async function weComTurn(opts: { onTap?: (a: any) => Promise<string | undefined> } = {}) {
  const server = new FakeWeComServer()
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: 'user-alice' }),
    getDisplayNames: () => new Map(),
    upsertElicit: vi.fn(async () => {})
  }
  const clock = { now: 1_700_000_000_000 }
  const messages: NormalizedMessage[] = []
  const conn = new WeComConnection(
    { botId: BOT, secret: 'secret-placeholder', integrations: [{ agentId: 'agent-1', integrationId: 'int-wecom' }] },
    {
      onMessage: (msg) => messages.push(msg),
      onElicitChoice: (a) => (opts.onTap ? opts.onTap(a) : daemon.permissions.handleElicitCardTap(a)),
      log: quietLog,
      createSocket: server.createSocket,
      now: () => clock.now
    }
  )
  connections.push(conn)
  await conn.start()
  daemon.pending.set(JSON.stringify(['agent-1', 's1']), {
    plan: {
      platform: 'wecom',
      agentId: 'agent-1',
      sessionKey: 'k1',
      channel: CHANNEL,
      transcriptChannel: CONVERSATION,
      statusThread: 'group',
      agentName: 'Butler',
      isDm: false,
      approvalSurfaceSuppressed: false
    },
    entry: { msg: {} },
    hostKey: 'agent-1',
    outwardSessionId: 'sess-1',
    egress: conn,
    turnState: { conn, channel: CHANNEL, msgId: 'msg-group-0001' },
    chrome: {},
    reply: { text: '', attemptText: '', attemptAnswerUpdates: [] },
    signals: { applyChain: Promise.resolve() },
    approval: { waitMs: 0, depth: 0 },
    builtinSystemToolCallIds: new Set<string>(),
    conv: { onUpdate: () => [], hasBuffered: () => false },
    rec: { onUpdate: () => [] },
    termOut: new TerminalOutputFolder(),
    workBoundary: new WorkBoundary()
  })
  const applied: any[] = []
  daemon.enqueueApply = (_p: any, action: any) => void applied.push(action)
  const socket = () => server.last
  const sends = (msgtype: string) =>
    socket()
      .frames('aibot_send_msg')
      .filter((f) => f.body?.msgtype === msgtype)
  return {
    server,
    daemon,
    conn,
    clock,
    messages,
    sends,
    updates: (): SentFrame[] => socket().frames('aibot_respond_update_msg'),
    markdown: () => sends('markdown').map((f) => (f.body!.markdown as { content: string }).content),
    notices: () => applied.filter((a) => a.kind === 'notice').map((a) => a.text)
  }
}

type Turn = Awaited<ReturnType<typeof weComTurn>>

async function raise(h: Turn, req: CreateElicitationRequest) {
  const result = h.daemon.permissions.onAcpElicit('agent-1', 's1', req)
  await vi.waitFor(() => expect(h.daemon.permissions.pendingApprovals.size).toBe(1))
  const requestId = [...h.daemon.permissions.pendingApprovals.keys()][0] as string
  await vi.waitFor(() => expect(h.daemon.permissions.pendingApprovals.get(requestId).card.ts).toBeDefined())
  return { requestId, result, ts: h.daemon.permissions.pendingApprovals.get(requestId).card.ts as string }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('a WeCom turn collects an answer from a tap', () => {
  it('sends the card proactively and closes it for everyone under the tap event req_id', async () => {
    const h = await weComTurn()
    const { requestId, result, ts } = await raise(h, form(BRANCH, ['branch']))
    expect(ts).toBe(`acq-b-${requestId}`)
    const [sent] = h.sends('template_card')
    expect(sent!.body).toEqual({
      chatid: CHANNEL,
      chat_type: 2,
      msgtype: 'template_card',
      template_card: weComQuestionCard(requestId, 'Butler', 'Which branch should I cut from?', targetOf(BRANCH))!.card
    })
    h.server.last.cardTap('tap-req-1', { taskId: ts, key: 'o1', chatid: CHANNEL })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    await vi.waitFor(() => expect(h.updates()).toHaveLength(1))
    expect(h.updates()[0]).toEqual({
      cmd: 'aibot_respond_update_msg',
      headers: { req_id: 'tap-req-1' },
      body: {
        response_type: 'update_template_card',
        template_card: {
          card_type: 'text_notice',
          main_title: { title: '✅ develop' },
          sub_title_text: 'Which branch should I cut from?',
          task_id: ts
        }
      }
    })
    await flush()
    expect(h.markdown()).toEqual([])
  })

  it('answers a yes/no card and a vote card by the tapped option', async () => {
    const yes = await weComTurn()
    const asked = await raise(yes, form(BOOL, ['proceed']))
    const index = targetOf(BOOL).options.findIndex((o) => o.value === 'true')
    yes.server.last.cardTap('tap-req-1', { taskId: asked.ts, key: `o${index}` })
    await expect(asked.result).resolves.toEqual({ action: 'accept', content: { proceed: true } })

    const vote = await weComTurn()
    const voting = await raise(vote, form(enumOf(8), ['branch']))
    expect(voting.ts).toMatch(/^acq-v-/)
    vote.server.last.cardTap('tap-req-2', { taskId: voting.ts, key: 'submit', selected: voted('o6') })
    await expect(voting.result).resolves.toEqual({ action: 'accept', content: { branch: 'b7' } })
    await vi.waitFor(() => expect(vote.updates()).toHaveLength(1))
  })

  it('settles a late tap but sends no update outside the window, posting the outcome instead', async () => {
    const h = await weComTurn({
      onTap: async (a) => {
        h.clock.now += WECOM_CARD_UPDATE_WINDOW_MS
        return await h.daemon.permissions.handleElicitCardTap(a)
      }
    })
    const { result, ts } = await raise(h, form(BRANCH, ['branch']))
    h.server.last.cardTap('tap-req-1', { taskId: ts, key: 'o0' })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })
    await vi.waitFor(() => expect(h.markdown()).toEqual(['💬 Which branch should I cut from?\n✅ main']))
    expect(h.updates()).toEqual([])
  })

  it('tolerates a refused update: the answer stands and the outcome is posted', async () => {
    const h = await weComTurn()
    h.server.answers.set('aibot_respond_update_msg', 600001)
    const { result, ts } = await raise(h, form(BRANCH, ['branch']))
    h.server.last.cardTap('tap-req-1', { taskId: ts, key: 'o1' })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    await vi.waitFor(() => expect(h.markdown()).toEqual(['💬 Which branch should I cut from?\n✅ develop']))
    expect(h.updates()).toHaveLength(1)
  })

  it('takes a repeated event once and a tap on a settled or unknown card settles nothing', async () => {
    const taps: unknown[] = []
    const h = await weComTurn({
      onTap: async (a) => {
        taps.push(a)
        return await h.daemon.permissions.handleElicitCardTap(a)
      }
    })
    const { result, ts } = await raise(h, form(BRANCH, ['branch']))
    h.server.last.cardTap('tap-req-1', { taskId: ts, key: 'o0', msgid: 'event-dup' })
    h.server.last.cardTap('tap-req-2', { taskId: ts, key: 'o1', msgid: 'event-dup' })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })
    await flush()
    expect(taps).toHaveLength(1)
    h.server.last.cardTap('tap-req-3', { taskId: `acq-b-${REQ}`, key: 'o0' })
    await flush()
    expect(taps).toHaveLength(2)
    expect(h.updates().map((f) => f.headers.req_id)).toEqual(['tap-req-1'])
    expect(h.notices()).toEqual([])
  })

  it('leaves the card as it is when the tapper may not answer', async () => {
    const h = await weComTurn({ onTap: async () => 'Only the person who asked can answer this.' })
    const { ts } = await raise(h, form(BRANCH, ['branch']))
    h.server.last.cardTap('tap-req-1', { taskId: ts, key: 'o0', userid: 'user-bob' })
    await flush()
    expect(h.daemon.permissions.pendingApprovals.size).toBe(1)
    expect(h.updates()).toEqual([])
    expect(h.markdown()).toEqual([])
  })
})

describe('a WeCom question closed elsewhere', () => {
  it('posts the outcome of an answer from the Console, and closes the card at its next tap without asking core', async () => {
    const taps: unknown[] = []
    const h = await weComTurn({
      onTap: async (a) => {
        taps.push(a)
        return await h.daemon.permissions.handleElicitCardTap(a)
      }
    })
    const { requestId, result, ts } = await raise(h, form(BRANCH, ['branch']))
    await h.daemon.permissions.handleElicitChoice({ requestId, value: elicitOptionToken(1) })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    await vi.waitFor(() => expect(h.markdown()).toEqual(['💬 Which branch should I cut from?\n✅ develop']))
    h.server.last.cardTap('tap-req-late', { taskId: ts, key: 'o0' })
    await vi.waitFor(() => expect(h.updates()).toHaveLength(1))
    expect(h.updates()[0]!.headers.req_id).toBe('tap-req-late')
    expect((h.updates()[0]!.body!.template_card as { main_title: unknown }).main_title).toEqual({
      title: '✅ develop'
    })
    expect(taps).toEqual([])
  })

  it('posts a cancellation when the turn ends with the question open', async () => {
    const h = await weComTurn()
    const { result } = await raise(h, form(BRANCH, ['branch']))
    await h.daemon.permissions.releaseApprovals('agent-1', 's1')
    await expect(result).resolves.toEqual({ action: 'cancel' })
    await vi.waitFor(() => expect(h.markdown()).toEqual(['💬 Which branch should I cut from?\n⏳ Cancelled']))
  })
})

describe('a WeCom question without a tap card', () => {
  it('asks with the numbered text card when WeCom refuses the template card, and takes a quote carrying its tag', async () => {
    const h = await weComTurn()
    h.server.answerBy = (frame) => (frame.body?.msgtype === 'template_card' ? 600001 : undefined)
    const { result, ts } = await raise(h, form(BRANCH, ['branch']))
    expect(ts).toMatch(/^Q-[0-9A-F]{8}$/)
    expect(h.markdown()).toEqual([weComElicitText('Which branch should I cut from?', targetOf(BRANCH), CHANNEL, ts)])
    const quote: WeComInboundMessage = {
      msgid: 'msg-group-0002',
      aibotid: BOT,
      chatid: CHANNEL,
      chattype: 'group',
      from: { userid: 'user-alice' },
      msgtype: 'text',
      text: { content: '@Example Bot 2' },
      quote: { msgtype: 'text', text: { content: h.markdown()[0]! } }
    } as WeComInboundMessage
    h.server.last.message('msg-req-2', quote as unknown as Record<string, unknown>)
    await vi.waitFor(() => expect(h.messages).toHaveLength(1))
    expect(h.messages[0]!.replyTo).toBe(ts)
    const claimed = await h.daemon.permissions.claimElicitReply({
      conversation: CONVERSATION,
      replyTo: h.messages[0]!.replyTo,
      text: h.messages[0]!.text,
      actor: { userId: 'user-alice' }
    })
    expect(claimed).toBe(true)
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    await flush()
    expect(h.markdown()).toHaveLength(1)
  })

  it('reads no quote as an answer unless it carries a live tag of that conversation', async () => {
    const h = await weComTurn()
    h.conn.noteQuestionTag(CHANNEL, 'Q-0A1B2C3D')
    const base = { aibotid: BOT, chattype: 'group', from: { userid: 'user-alice' }, msgtype: 'text' }
    const send = (msgid: string, chatid: string, quoted: string) =>
      h.server.last.message(msgid, {
        ...base,
        msgid,
        chatid,
        text: { content: '@Example Bot 2' },
        quote: { msgtype: 'text', text: { content: quoted } }
      })
    send('msg-a', CHANNEL, 'an ordinary message')
    send('msg-b', 'chat-example-other', 'Quote this message (Q-0A1B2C3D)')
    h.conn.retireQuestionTag('Q-0A1B2C3D')
    send('msg-c', CHANNEL, 'Quote this message (Q-0A1B2C3D)')
    await vi.waitFor(() => expect(h.messages).toHaveLength(3))
    expect(h.messages.map((m) => m.replyTo)).toEqual([undefined, undefined, undefined])
  })

  it('repeats the instruction for a quote naming no option and keeps the question open', async () => {
    const h = await weComTurn()
    h.server.answerBy = (frame) => (frame.body?.msgtype === 'template_card' ? 600001 : undefined)
    const { ts } = await raise(h, form(BRANCH, ['branch']))
    const claimed = await h.daemon.permissions.claimElicitReply({
      conversation: CONVERSATION,
      replyTo: ts,
      text: 'maybe',
      actor: { userId: 'user-alice' }
    })
    expect(claimed).toBe(true)
    expect(h.daemon.permissions.pendingApprovals.size).toBe(1)
    await vi.waitFor(() => expect(h.markdown().at(-1)).toBe('Quote the question and reply with a number from 1 to 2.'))
  })

  it('asks a question too long for the card with the text card', async () => {
    const h = await weComTurn()
    const long = { ...form(BRANCH, ['branch']), message: 'Which branch? '.repeat(20) } as CreateElicitationRequest
    const { ts } = await raise(h, long)
    expect(ts).toMatch(/^Q-/)
    expect(h.sends('template_card')).toEqual([])
  })

  it('still declines a typed question it has no control for', async () => {
    const h = await weComTurn()
    const req = form({ note: { type: 'string', title: 'Note' } }, ['note'])
    await expect(h.daemon.permissions.onAcpElicit('agent-1', 's1', req)).resolves.toBeUndefined()
    expect(h.server.last.frames('aibot_send_msg')).toEqual([])
  })

  it('cancels the question when neither card can go out, as when the hour budget is spent', async () => {
    const h = await weComTurn()
    const budget = (h.conn as any).budget
    for (let i = 0; i < WECOM_PER_HOUR; i++) budget.note(CHANNEL)
    const result = h.daemon.permissions.onAcpElicit('agent-1', 's1', form(BRANCH, ['branch']))
    await expect(result).resolves.toEqual({ action: 'cancel' })
    expect(h.server.last.frames('aibot_send_msg')).toEqual([])
  })
})

describe('the WeCom send budget for question cards', () => {
  it('counts the card send and its update against the conversation', async () => {
    const h = await weComTurn()
    const budget = (h.conn as any).budget
    const used = () => budget.used(CHANNEL).minute as number
    const { ts } = await raise(h, form(BRANCH, ['branch']))
    expect(used()).toBe(1)
    h.server.last.cardTap('tap-req-1', { taskId: ts, key: 'o0' })
    await vi.waitFor(() => expect(h.updates()).toHaveLength(1))
    expect(used()).toBe(2)
  })
})
