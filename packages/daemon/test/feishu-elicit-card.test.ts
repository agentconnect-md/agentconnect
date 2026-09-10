/**
 * Feishu's elicitation card — the fourth implementer of the Layer-2 elicitation-card facet
 * (#1794), and the last chat surface it was waiting on. A CardKit 2.0 `form` container holds a
 * named control per field around one submit button, so the whole reduction is answered in the
 * message; a lone single-select or boolean keeps the button row every surface gives it.
 *
 * These tests pin the CARD WE BUILD and the answer we take back from it. They cannot pin what
 * Feishu accepts — a CardKit card is opaque JSON and the Lark SDK ships no schema — which is the
 * one thing about this surface that a live check has to settle.
 */
import { describe, it, expect, vi } from 'vitest'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { elicitFormBlockId } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { FeishuConnection } from '../src/feishu/connection.js'
import { elicitForm, elicitOptionToken, elicitTarget } from '../src/slack/render.js'
import {
  FEISHU_ELICIT_ACTION,
  FEISHU_ELICIT_SURFACE,
  buildFeishuElicitForm,
  feishuElicitValue,
  feishuUsesForm,
  parseFeishuElicit
} from '../src/platforms/feishu/elicit-card.js'

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
const CHECKS = { checks: { type: 'array', items: { type: 'string', enum: ['lint', 'test'] }, title: 'Checks' } }

/** The card's top-level elements. */
function elements(card: any): any[] {
  return card.body.elements
}

/** The `form` container's own child elements. */
function formElements(card: any): any[] {
  return elements(card).find((e: any) => e.tag === 'form').elements
}

describe('the payload a Feishu elicitation comes back on', () => {
  it('names itself, so a session-control tap is never read as an answer', () => {
    expect(parseFeishuElicit(feishuElicitValue(REQUEST_ID, elicitOptionToken(2)))).toEqual({
      requestId: REQUEST_ID,
      token: elicitOptionToken(2)
    })
    // Dismiss is no answer, so it decodes as none.
    expect(parseFeishuElicit(feishuElicitValue(REQUEST_ID, 'x'))).toEqual({ requestId: REQUEST_ID, token: null })
    // The reply card's own overflow payload, which this decoder must never claim.
    expect(parseFeishuElicit({ action: 'agentconnect_reply' })).toBeNull()
    expect(parseFeishuElicit({ action: FEISHU_ELICIT_ACTION })).toBeNull()
    expect(parseFeishuElicit('ac_el:x:y')).toBeNull()
    expect(parseFeishuElicit(undefined)).toBeNull()
  })
})

describe('what Feishu declares it can collect, and which card collects it', () => {
  it('claims every kind, because a CardKit form has a control for every kind', () => {
    expect([...FEISHU_ELICIT_SURFACE.kinds].sort()).toEqual(['boolean', 'enum', 'multi-enum', 'number', 'text'])
  })

  it('answers a lone single-select or boolean with a tap, and everything else in the form', () => {
    expect(feishuUsesForm(elicitForm(form(BRANCH), FEISHU_ELICIT_SURFACE)!)).toBe(false)
    expect(feishuUsesForm(elicitForm(form({ ok: { type: 'boolean' } }), FEISHU_ELICIT_SURFACE)!)).toBe(false)
    expect(feishuUsesForm(elicitForm(form(CHECKS), FEISHU_ELICIT_SURFACE)!)).toBe(true)
    expect(feishuUsesForm(elicitForm(form({ note: { type: 'string' } }), FEISHU_ELICIT_SURFACE)!)).toBe(true)
    expect(feishuUsesForm(elicitForm(form({ ...BRANCH, ...CHECKS }), FEISHU_ELICIT_SURFACE)!)).toBe(true)
  })

  it('reduces every kind rather than dropping one, a typed field included', () => {
    expect(elicitTarget(form(BRANCH), FEISHU_ELICIT_SURFACE)?.kind).toBe('enum')
    expect(elicitTarget(form(CHECKS), FEISHU_ELICIT_SURFACE)?.kind).toBe('multi-enum')
    expect(elicitTarget(form({ note: { type: 'string' } }), FEISHU_ELICIT_SURFACE)?.kind).toBe('text')
    expect(elicitTarget(form({ n: { type: 'integer' } }), FEISHU_ELICIT_SURFACE)?.kind).toBe('number')
  })
})

describe('the form card one reduction becomes', () => {
  const build = (params: CreateElicitationRequest) =>
    buildFeishuElicitForm(REQUEST_ID, params, elicitForm(params, FEISHU_ELICIT_SURFACE)!)

  it('gives each field its own named control, and the whole card ONE Confirm', () => {
    const params = form({ ...BRANCH, ...CHECKS, note: { type: 'string', title: 'Notes' } }, ['branch'])
    const card = build(params)!
    expect(card.schema).toBe('2.0')
    const inside = formElements(card)

    // A single-select, a multi-select and a typed box — one control each, named by the very key
    // a Slack Confirm submits under.
    expect(inside.slice(0, 3).map((e: any) => [e.tag, e.name])).toEqual([
      ['select_static', elicitFormBlockId(0)],
      ['multi_select_static', elicitFormBlockId(1)],
      ['input', elicitFormBlockId(2)]
    ])
    // Required-ness is the schema's, per field.
    expect(inside.map((e: any) => e.required)).toEqual([true, false, false, undefined])
    // Every option carries its POSITION, never its own value.
    expect(inside[0].options.map((o: any) => o.value)).toEqual([elicitOptionToken(0), elicitOptionToken(1)])
    expect(inside[0].options.map((o: any) => o.text.content)).toEqual(['main', 'develop'])

    // One Confirm for the whole card, and it is the control that reads every field above.
    const actions = inside.at(-1).actions
    expect(actions.map((a: any) => a.text.content)).toEqual(['Confirm', 'Dismiss'])
    expect(actions[0].form_action_type).toBe('submit')
    expect(actions[0].behaviors[0].value).toEqual(feishuElicitValue(REQUEST_ID, 'ok'))
    expect(actions[1].behaviors[0].value).toEqual(feishuElicitValue(REQUEST_ID, 'x'))
  })

  it('declines an option list past what this card offers, rather than showing part of it', () => {
    const many = (n: number) => ({ pick: { type: 'string', enum: Array.from({ length: n }, (_, i) => `o${i}`) } })
    // The reduction refuses it first, which is the surface's own limit doing its job.
    expect(elicitForm(form(many(25)), FEISHU_ELICIT_SURFACE)).toBeNull()
    expect(elicitForm(form(many(24)), FEISHU_ELICIT_SURFACE)).not.toBeNull()
  })
})

// -- the coordinator, on a Feishu turn --------------------------------------------------------

interface Harness {
  daemon: any
  conn: any
  cards: { channel: string; anchor?: string; card: any }[]
  edits: { messageId: string; card: any }[]
  notices: () => string[]
}

function feishuTurn(turn: { thread?: string } = {}): Harness {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: () => new Map(),
    upsertElicit: vi.fn(async () => {})
  }
  const cards: { channel: string; anchor?: string; card: any }[] = []
  const edits: { messageId: string; card: any }[] = []
  const conn = Object.create(FeishuConnection.prototype)
  conn.postElicitCard = async (channel: string, anchor: string | undefined, card: any) => {
    cards.push({ channel, anchor, card })
    return 'om_4242'
  }
  conn.updateElicitCard = async (messageId: string, card: any) => void edits.push({ messageId, card })
  daemon.pending.set(JSON.stringify(['agent-1', 's1']), {
    plan: {
      platform: 'feishu',
      agentId: 'agent-1',
      sessionKey: 'k1',
      requesterId: 'turn-user',
      channel: 'oc_chat',
      transcriptChannel: 'oc_chat',
      statusThread: 'T1',
      agentName: 'agent',
      isDm: false,
      approvalSurfaceSuppressed: false,
      ...(turn.thread !== undefined ? { thread: turn.thread } : {})
    },
    hostKey: 'agent-1',
    outwardSessionId: 'sess-1',
    conn,
    turnState: {},
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
    notices: () => applied.filter((a) => a.kind === 'notice').map((a) => a.text as string)
  }
}

async function raise(h: Harness, req: CreateElicitationRequest): Promise<{ requestId: string; result: Promise<any> }> {
  const result = h.daemon.permissions.onAcpElicit('agent-1', 's1', req)
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.size).toBe(1))
  const requestId = [...h.daemon.permissions.pendingElicits.keys()][0] as string
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.get(requestId).ts).toBe('om_4242'))
  return { requestId, result }
}

describe('a Feishu turn posts an elicitation card and settles it in place', () => {
  it('answers a lone single-select with one tap, and rewrites the card with the answer', async () => {
    const h = feishuTurn()
    const { requestId, result } = await raise(h, form(BRANCH, ['branch']))
    const actions = elements(h.cards[0]!.card).find((e: any) => e.tag === 'action').actions
    expect(actions.map((a: any) => a.text.content)).toEqual(['main', 'develop', 'Dismiss'])

    await h.daemon.permissions.handleElicitCardTap({ requestId, token: elicitOptionToken(1) })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    expect(h.edits[0]!.messageId).toBe('om_4242')
    expect(elements(h.edits[0]!.card)[0].content).toBe('💬 Which branch should I cut from?\n✅ develop')
    // Nothing is left to press on an answered card.
    expect(elements(h.edits[0]!.card)).toHaveLength(1)
  })

  it('takes a whole form back from one Confirm', async () => {
    const h = feishuTurn()
    const params = form({ ...CHECKS, note: { type: 'string', title: 'Notes' } }, ['checks'])
    const { requestId, result } = await raise(h, params)
    // A multi-select answers with a list and a text input with words; the FIELD says which.
    await h.daemon.permissions.submitElicitEditor({
      requestId,
      values: { [elicitFormBlockId(0)]: [elicitOptionToken(0), elicitOptionToken(1)], [elicitFormBlockId(1)]: 'ship' }
    })
    await expect(result).resolves.toEqual({
      action: 'accept',
      content: { checks: ['lint', 'test'], note: 'ship' }
    })
    expect(elements(h.edits.at(-1)!.card)[0].content).toContain('Checks: lint, test')
  })

  it('reads a single-select control as the one value it holds, list or not', async () => {
    const h = feishuTurn()
    const { requestId, result } = await raise(h, form({ ...BRANCH, ...CHECKS }, ['branch']))
    await h.daemon.permissions.submitElicitEditor({
      requestId,
      values: { [elicitFormBlockId(0)]: elicitOptionToken(0) }
    })
    // The untouched optional multi-select is an OMISSION, not an empty answer.
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })
  })

  it('refuses a Confirm missing a required field, and leaves the card live', async () => {
    const h = feishuTurn()
    const { requestId } = await raise(h, form({ ...CHECKS, note: { type: 'string' } }, ['checks']))
    await h.daemon.permissions.submitElicitEditor({ requestId, values: { [elicitFormBlockId(1)]: 'ship' } })
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    expect(h.notices().at(-1)).toContain('Checks')
  })

  it('refuses an option position the card never offered', async () => {
    const h = feishuTurn()
    const { requestId } = await raise(h, form(CHECKS, ['checks']))
    await h.daemon.permissions.submitElicitEditor({
      requestId,
      values: { [elicitFormBlockId(0)]: [elicitOptionToken(9)] }
    })
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    expect(h.notices().at(-1)).toContain("wasn't accepted")
  })

  it('reads Dismiss as the decline it is, on either card', async () => {
    const h = feishuTurn()
    const { requestId, result } = await raise(h, form(CHECKS, ['checks']))
    await h.daemon.permissions.handleElicitCardTap({ requestId, token: null })
    await expect(result).resolves.toEqual({ action: 'decline' })
    expect(elements(h.edits.at(-1)!.card)[0].content).toContain('Dismissed')
  })

  it('anchors the card into the turn thread when the turn has one', async () => {
    const h = feishuTurn({ thread: 'om_root' })
    await raise(h, form(BRANCH, ['branch']))
    expect(h.cards[0]!.anchor).toBe('om_root')
    expect(h.cards[0]!.channel).toBe('oc_chat')
  })

  it('declines URL mode, whose consent a CardKit link button could never report', async () => {
    const h = feishuTurn()
    const req = {
      sessionId: 's1',
      mode: 'url',
      message: 'Sign in to continue',
      url: 'https://example.com/oauth',
      elicitationId: 'e1'
    } as unknown as CreateElicitationRequest
    await expect(h.daemon.permissions.onAcpElicit('agent-1', 's1', req)).resolves.toBeUndefined()
    expect(h.cards).toEqual([])
    expect(h.notices().at(-1)).toContain("can't collect an answer for")
  })

  it('cancels an abandoned card and says so on the card itself', async () => {
    const h = feishuTurn()
    const { result } = await raise(h, form(CHECKS, ['checks']))
    await h.daemon.permissions.releaseElicits('agent-1', 's1')
    await expect(result).resolves.toEqual({ action: 'cancel' })
    expect(elements(h.edits.at(-1)!.card)[0].content).toContain('Cancelled')
  })
})
