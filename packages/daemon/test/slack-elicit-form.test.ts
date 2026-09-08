/**
 * A Slack elicitation whose answer has to be FILLED IN (issue #1794's last Slack-column item).
 * Only a lone single-select or boolean is a row of buttons — one tap answers it — and everything
 * else is `input` blocks in the message itself with one Confirm and one Dismiss: several
 * questions, a question with its own free-text box, a multi-select, a typed box.
 *
 * There is no modal. Slack carries a message's whole input state on any `block_actions` payload,
 * so Confirm submits every field the tapping reader had filled in, and the record is re-validated
 * whole against the card that offered it before the ACP request is resolved.
 */
import { describe, it, expect, vi } from 'vitest'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import type { ElicitTarget } from '../src/slack/render.js'
import { Daemon } from '../src/daemon.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { SlackConnection } from '../src/slack/connection.js'
import {
  ELICIT_CONFIRM_ACTION,
  ELICIT_DISMISS_ACTION,
  SLACK_DM_ELICIT_SURFACE,
  SLACK_ELICIT_SURFACE,
  buildElicitationCard,
  buildElicitationFormCard,
  elicitCardShape,
  elicitForm,
  decodePermValue,
  elicitFormBlockId,
  elicitFormSubmission,
  elicitOptionToken,
  elicitTarget,
  slackCardViolations
} from '../src/slack/render.js'
import { encodeSharedSlackStatusTarget } from '@agentconnect.md/protocol'

const TARGET = encodeSharedSlackStatusTarget({ agentId: 'agent-1', integrationId: 'int-a', sessionKey: 'k1' })

function form(properties: Record<string, unknown>, required: string[] = []): CreateElicitationRequest {
  return {
    sessionId: 's1',
    mode: 'form',
    message: 'How should I cut the release?',
    requestedSchema: { type: 'object', properties, required }
  } as CreateElicitationRequest
}

/** One field of every kind Slack claims, so the card's whole element table is exercised. */
const EVERY_KIND = {
  branch: { type: 'string', enum: ['main', 'develop'], title: 'Base branch' },
  checks: { type: 'array', items: { type: 'string', enum: ['lint', 'test'] }, minItems: 1, title: 'Checks' },
  note: { type: 'string', maxLength: 20, description: 'Anything the reviewer should know' },
  count: { type: 'integer', minimum: 1, maximum: 9 },
  draft: { type: 'boolean', default: true }
}

/** The two-field form most of these use: a required pick plus an optional typed note. */
const TWO = {
  branch: { type: 'string', enum: ['main', 'develop'], title: 'Base branch' },
  note: { type: 'string', maxLength: 20 }
}

const cardFor = (req: CreateElicitationRequest, target?: string) =>
  buildElicitationFormCard('elicit-1', req, elicitForm(req, SLACK_ELICIT_SURFACE)!, target) as any[] | null
const inputsOf = (blocks: any[] | null) => (blocks ?? []).filter((b) => b.type === 'input')

describe('the in-message card a filled-in answer is given on', () => {
  it('renders one input block per field, each with its own kind and bounds, then ONE Confirm', () => {
    const card = cardFor(form(EVERY_KIND, ['branch', 'checks']), TARGET)!
    expect(slackCardViolations(card)).toEqual([])
    const inputs = inputsOf(card)
    expect(inputs.map((b) => [b.block_id, b.element.type, b.optional, b.label.text])).toEqual([
      [elicitFormBlockId(0), 'radio_buttons', false, 'Base branch'],
      [elicitFormBlockId(1), 'checkboxes', false, 'Checks'],
      [elicitFormBlockId(2), 'plain_text_input', true, 'note'],
      [elicitFormBlockId(3), 'number_input', true, 'count'],
      [elicitFormBlockId(4), 'radio_buttons', true, 'draft']
    ])
    // The POSITION, not the value: an option value rides {@link elicitOptionToken} on every
    // Slack card, which is what keeps a long one from costing the whole message (#1794).
    expect(inputs[0]!.element.options.map((o: any) => o.value)).toEqual([elicitOptionToken(0), elicitOptionToken(1)])
    // `minItems` has no Slack attribute — and `checkboxes` has no `max_selected_items` at all —
    // so the bounds are said as a hint and enforced when the answer comes back.
    expect(inputs[1]!.hint.text).toBe('Select at least 1.')
    expect(inputs[1]!.element.max_selected_items).toBeUndefined()
    expect(inputs[2]!.element.max_length).toBe(20)
    expect(inputs[2]!.hint.text).toBe('Anything the reviewer should know')
    expect(inputs[3]!.element).toMatchObject({ is_decimal_allowed: false, min_value: '1', max_value: '9' })
    // A boolean's `default` seeds the control with the option that spells it.
    expect(inputs[4]!.element.initial_option.value).toBe(elicitOptionToken(0))
    // The question is a section, and the FIRST thing on the card.
    expect(card[0]).toMatchObject({ type: 'section' })
    expect(card[0].text.text).toContain('How should I cut the release?')
    // ONE Confirm for the whole card, never one per question, beside Dismiss — and they keep the
    // actions block whose block_id the relay routes on.
    const actions = card[card.length - 1]
    expect(actions.type).toBe('actions')
    expect(actions.block_id).toBe(TARGET)
    expect(actions.elements.map((e: any) => [e.action_id, e.value, e.text.text])).toEqual([
      [ELICIT_CONFIRM_ACTION, 'elicit-1', 'Confirm'],
      [ELICIT_DISMISS_ACTION, 'elicit-1', 'Dismiss']
    ])
  })

  // Slack caps `checkboxes` and `radio_buttons` at ten options and answers `no more than 10 items
  // allowed` past that; the select menus hold a hundred. The card picks by list length, not taste.
  it('falls back to the select menus past the ten options a checkbox or radio list holds', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `o${i}`)
    const short = cardFor(
      form({
        pick: { type: 'string', enum: many(10) },
        many: { type: 'array', items: { type: 'string', enum: many(10) } }
      })
    )!
    expect(inputsOf(short).map((b) => b.element.type)).toEqual(['radio_buttons', 'checkboxes'])
    const long = cardFor(
      form({
        pick: { type: 'string', enum: many(11) },
        many: { type: 'array', items: { type: 'string', enum: many(11) } }
      })
    )!
    expect(inputsOf(long).map((b) => b.element.type)).toEqual(['static_select', 'multi_static_select'])
    expect(slackCardViolations(short)).toEqual([])
    expect(slackCardViolations(long)).toEqual([])
  })

  it('defuses the agent’s own message exactly as every other card does', () => {
    const req = form(TWO, ['branch'])
    ;(req as any).message = 'Sign in at https://evil.example/x <https://evil.example/y|here>'
    const card = cardFor(req)!
    expect(card[0].text.text).toContain('`https://evil.example/x`')
    expect(card[0].text.text).toContain('&lt;')
    expect(card[0].text.text).not.toContain('<https://evil.example/y|here>')
  })

  it('is withheld when a field cannot BE an input block, so no card is ever posted dead', () => {
    // A minimum length no input can hold. (An option value past Slack's 75 no longer withholds
    // anything: the option carries its position instead — #1794.)
    expect(cardFor(form({ a: { type: 'string', minLength: 3500 }, b: { type: 'boolean' } }))).toBeNull()
  })
})

// The crux of the shape matrix: a button submits the instant it is tapped, so it can only answer
// a question that needs nothing filled in first.
describe('a card is a button row exactly when ONE TAP can answer it', () => {
  const shape = (props: Record<string, unknown>, required: string[] = []) =>
    elicitCardShape(elicitForm(form(props, required), SLACK_ELICIT_SURFACE)!)

  it('gives buttons to a lone single-select or boolean, and inputs to everything else', () => {
    expect(shape({ branch: { type: 'string', enum: ['main', 'dev'] } })).toBe('buttons')
    expect(shape({ draft: { type: 'boolean' } })).toBe('buttons')
    // A multi-select cannot be carried by a tap; a typed box has to be typed into first.
    expect(shape({ checks: { type: 'array', items: { type: 'string', enum: ['lint'] } } })).toBe('inputs')
    expect(shape({ note: { type: 'string' } })).toBe('inputs')
    expect(shape({ count: { type: 'integer' } })).toBe('inputs')
    // Several questions, however each is answered.
    expect(shape(TWO, ['branch'])).toBe('inputs')
  })

  // The distinction that decides this: `elicitForm` marks a select question's own free-text box
  // with `customAnswerFor`, so a question WITH a box is two targets and one question, where two
  // questions are two of each. Either way the card needs its inputs — and a companion box is
  // precisely a thing to fill in before submitting, so its question loses the button row.
  it('gives a single-select with its own “Other” box radio buttons and that box, plus one Confirm', () => {
    const req = form({
      branch: { type: 'string', enum: ['main', 'develop'], title: 'Base branch' },
      other: {
        type: 'string',
        title: 'Other',
        _meta: { _askUserQuestionCustomAnswer: { isCustomAnswer: true, questionId: 'branch' } }
      }
    })
    const reduced = elicitForm(req, SLACK_ELICIT_SURFACE)!
    expect(reduced).toHaveLength(2)
    expect(reduced.filter((t) => !t.customAnswerFor)).toHaveLength(1)
    expect(elicitCardShape(reduced)).toBe('inputs')
    const card = cardFor(req)!
    expect(slackCardViolations(card)).toEqual([])
    expect(inputsOf(card).map((b) => [b.element.type, b.label.text])).toEqual([
      ['radio_buttons', 'Base branch'],
      // The box is named for the question it belongs to, never "Other" on its own.
      ['plain_text_input', 'Base branch (Other)']
    ])
    expect(card[card.length - 1].elements[0].action_id).toBe(ELICIT_CONFIRM_ACTION)
  })

  it('keeps the one-tap row for a lone select — the same field, alone, does not lose its tap', () => {
    const req = form({ branch: { type: 'string', enum: ['main', 'develop'] } }, ['branch'])
    const card = buildElicitationCard('elicit-1', req, TARGET) as any[]
    expect(slackCardViolations(card)).toEqual([])
    expect(card[1].elements.map((e: any) => e.text.text)).toEqual(['main', 'develop', 'Dismiss'])
    expect(JSON.stringify(card)).not.toContain(ELICIT_CONFIRM_ACTION)
  })
})

/** What a Slack card carries back for one of a field's options: its POSITION (#1794). A value the
 *  field never offered has no position, and the token it yields resolves to nothing. */
const pick = (targets: ElicitTarget[], index: number, value: string) =>
  elicitOptionToken(targets[index]!.options.findIndex((o) => o.value === value))

describe('a form submission is re-derived against the card that offered it', () => {
  const req = form(EVERY_KIND, ['branch', 'checks'])
  const fields = elicitForm(req, SLACK_ELICIT_SURFACE)!
  const carried = (index: number, value: string) => pick(fields, index, value)

  it('answers with the typed record — real numbers, arrays, the boolean’s own wire value', () => {
    expect(
      elicitFormSubmission(req, fields, {
        [elicitFormBlockId(0)]: carried(0, 'main'),
        [elicitFormBlockId(1)]: [carried(1, 'lint'), carried(1, 'test')],
        [elicitFormBlockId(2)]: 'ship it',
        [elicitFormBlockId(3)]: '4',
        [elicitFormBlockId(4)]: carried(4, 'false')
      })
    ).toEqual({ answer: { branch: 'main', checks: ['lint', 'test'], note: 'ship it', count: 4, draft: 'false' } })
  })

  it('accepts an omitted OPTIONAL field and refuses a missing REQUIRED one', () => {
    expect(
      elicitFormSubmission(req, fields, {
        [elicitFormBlockId(0)]: carried(0, 'main'),
        [elicitFormBlockId(1)]: [carried(1, 'lint')]
      })
    ).toEqual({ answer: { branch: 'main', checks: ['lint'] } })
    expect(elicitFormSubmission(req, fields, { [elicitFormBlockId(0)]: carried(0, 'main') })).toEqual({
      errors: { [elicitFormBlockId(1)]: 'This field is required.' }
    })
  })

  // Slack sends `[]` for a multi-select nobody touched. Reading that as an empty ANSWER made an
  // optional `minItems: 1` field unsubmittable — the reader could not get past their own blank.
  it('takes a blank OPTIONAL multi-select as omitted, not as a selection that fails its bounds', () => {
    const optional = form(
      { branch: EVERY_KIND.branch, checks: { type: 'array', minItems: 1, items: EVERY_KIND.checks.items } },
      ['branch']
    )
    const target = elicitForm(optional, SLACK_ELICIT_SURFACE)!
    expect(
      elicitFormSubmission(optional, target, {
        [elicitFormBlockId(0)]: pick(target, 0, 'main'),
        [elicitFormBlockId(1)]: []
      })
    ).toEqual({ answer: { branch: 'main' } })
    // A REQUIRED one keeps its own bounds: there an empty selection is a real answer to judge.
    const needed = form({ checks: { type: 'array', minItems: 1, items: EVERY_KIND.checks.items } }, ['checks'])
    const neededTarget = elicitForm(needed, SLACK_ELICIT_SURFACE)!
    expect(elicitFormSubmission(needed, neededTarget, { [elicitFormBlockId(0)]: [] }).errors).toBeDefined()
  })

  it('refuses ONE bad field with that field’s own error, rather than dropping it', () => {
    const bad = elicitFormSubmission(req, fields, {
      [elicitFormBlockId(0)]: 'trunk', // never offered, so no position stands for it
      [elicitFormBlockId(1)]: [carried(1, 'lint')],
      [elicitFormBlockId(2)]: 'x'.repeat(50), // past maxLength
      [elicitFormBlockId(3)]: '40' // past maximum
    })
    expect(bad.answer).toBeUndefined()
    expect(bad.errors).toEqual({
      [elicitFormBlockId(0)]: 'Choose one of the options offered.',
      [elicitFormBlockId(2)]: 'Enter some text, at most 20 characters long.',
      [elicitFormBlockId(3)]: 'Enter a whole number from 1 to 9.'
    })
  })

  it('refuses a value of the wrong SHAPE, and ignores a block the form never rendered', () => {
    expect(
      elicitFormSubmission(req, fields, {
        [elicitFormBlockId(0)]: [carried(0, 'main')], // a list cannot answer a single select
        [elicitFormBlockId(1)]: [carried(1, 'lint')]
      }).errors
    ).toEqual({ [elicitFormBlockId(0)]: 'Choose one of the options offered.' })
    expect(
      elicitFormSubmission(req, fields, {
        [elicitFormBlockId(0)]: carried(0, 'main'),
        [elicitFormBlockId(1)]: [carried(1, 'lint')],
        [elicitFormBlockId(99)]: 'injected',
        not_ours: 'injected'
      })
    ).toEqual({ answer: { branch: 'main', checks: ['lint'] } })
  })

  it('validates a pattern Slack has no attribute for, and returns it as that field’s error', () => {
    const patterned = form({ tag: { type: 'string', pattern: '^v[0-9]+$' }, note: { type: 'string' } }, ['tag'])
    const shape = elicitForm(patterned, SLACK_ELICIT_SURFACE)!
    expect(JSON.stringify(cardFor(patterned))).not.toContain('pattern')
    expect(elicitFormSubmission(patterned, shape, { [elicitFormBlockId(0)]: 'v12' })).toEqual({
      answer: { tag: 'v12' }
    })
    expect(elicitFormSubmission(patterned, shape, { [elicitFormBlockId(0)]: 'release-12' }).errors).toEqual({
      [elicitFormBlockId(0)]: 'Enter some text, in the exact format the question asks for.'
    })
  })
})

describe('the approval-DM surface stays one tap', () => {
  it('builds no card for a form asking two questions, so a DM never posts a dead Confirm', () => {
    // Both kinds ARE in the DM surface, so this is not a kind refusal: a DM card settles through
    // the editor path, which holds no per-card state, so nothing needing a Confirm can live there.
    const req = form({ branch: { type: 'string', enum: ['main', 'dev'] }, draft: { type: 'boolean' } }, [
      'branch',
      'draft'
    ])
    expect([...SLACK_DM_ELICIT_SURFACE.kinds].sort()).toEqual(['boolean', 'enum'])
    expect(elicitTarget(req, SLACK_DM_ELICIT_SURFACE)).toBeNull()
    expect(buildElicitationCard('elicit-1', req, undefined, SLACK_DM_ELICIT_SURFACE)).toBeNull()
  })
})

// ── the coordinator: posting the card, settling on Confirm ────────────────────────────────────

function installPending(daemon: any): any {
  daemon.store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: () => new Map(),
    createPermissionRequest: vi.fn(),
    resolvePermissionRequest: vi.fn(() => true),
    upsertElicit: vi.fn(async () => {})
  }
  const pending = {
    plan: {
      platform: 'slack',
      agentId: 'agent-1',
      integrationId: 'int-a',
      sessionKey: 'k1',
      requesterId: 'turn-user',
      channel: 'C1',
      transcriptChannel: 'C1',
      statusThread: 'T1',
      isDm: false,
      approvalSurfaceSuppressed: false
    },
    hostKey: 'agent-1',
    outwardSessionId: 'sess-1',
    chrome: {},
    reply: { text: '', attemptText: '', attemptAnswerUpdates: [] },
    signals: { applyChain: Promise.resolve() },
    approval: { waitMs: 0, depth: 0 },
    builtinSystemToolCallIds: new Set<string>(),
    conv: { onUpdate: () => [], hasBuffered: () => false },
    rec: { onUpdate: () => [] },
    termOut: new TerminalOutputFolder()
  }
  daemon.pending.set(JSON.stringify(['agent-1', 's1']), pending)
  return pending
}

interface Harness {
  daemon: any
  conn: any
  posted: unknown[][]
  updated: unknown[][]
  notices: () => string[]
}

/** A Slack turn on an HTTP (relay-fronted) integration, with everything the card touches captured. */
function slackTurn(): Harness {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  installPending(daemon)
  const posted: unknown[][] = []
  const updated: unknown[][] = []
  const conn = Object.create(SlackConnection.prototype)
  conn.postBlocks = async (_c: string, blocks: unknown[]) => {
    posted.push(blocks)
    return 'ts-1'
  }
  conn.updateBlocks = async (_c: string, _ts: string, blocks: unknown[]) => {
    updated.push(blocks)
    return true
  }
  conn.workspaceId = () => 'T1'
  daemon.pending.get(JSON.stringify(['agent-1', 's1'])).conn = conn
  daemon.httpSlackSessionTarget = () => TARGET
  daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example' }
  const applied: any[] = []
  daemon.enqueueApply = (_p: any, action: any) => void applied.push(action)
  return {
    daemon,
    conn,
    posted,
    updated,
    notices: () => applied.filter((a) => a.kind === 'notice').map((a) => a.text as string)
  }
}

/** Raise the form elicitation and wait until its card is posted and its ts recorded. */
async function raise(h: Harness, req: CreateElicitationRequest): Promise<{ requestId: string; result: Promise<any> }> {
  const result = h.daemon.permissions.onAcpElicit('agent-1', 's1', req)
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.size).toBe(1))
  const requestId = [...h.daemon.permissions.pendingElicits.keys()][0] as string
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.get(requestId).ts).toBe('ts-1'))
  return { requestId, result }
}

/** What a Confirm on the TWO-field card carries: `branch` is an enum, so the card sends its
 *  option's POSITION (#1794), never the value itself. */
const submitFields = (branch: 'main' | 'develop', note?: string) => ({
  [elicitFormBlockId(0)]: elicitOptionToken(branch === 'main' ? 0 : 1),
  ...(note !== undefined ? { [elicitFormBlockId(1)]: note } : {})
})

describe('a Slack turn answers a form card from its own Confirm', () => {
  it('posts the inputs in the channel, and accepts the typed record on Confirm', async () => {
    const h = slackTurn()
    const { requestId, result } = await raise(h, form(TWO, ['branch']))
    expect(h.notices()).toEqual([])
    expect(inputsOf(h.posted[0] as any[])).toHaveLength(2)
    expect(slackCardViolations(h.posted[0] as any[])).toEqual([])

    await h.daemon.permissions.submitElicitForm({
      requestId,
      fields: submitFields('develop', 'ship it'),
      actor: { userId: 'U-ALICE', name: 'alice' }
    })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop', note: 'ship it' } })
    // The card is rewritten to the settled state, naming the fields in the card's own words.
    expect(JSON.stringify(h.updated[0])).toContain('Base branch: develop')
    expect(JSON.stringify(h.updated[0])).toContain('note: ship it')
    expect(h.daemon.permissions.pendingElicits.size).toBe(0)
  })

  it('takes an omitted optional field and refuses a missing required one, leaving the card live', async () => {
    const h = slackTurn()
    const { requestId, result } = await raise(h, form(TWO, ['branch']))
    await h.daemon.permissions.submitElicitForm({ requestId, fields: { [elicitFormBlockId(1)]: 'note only' } })
    // No modal to hand the errors back to, so the thread is told which field refused it.
    expect(h.notices()).toEqual([
      "That answer wasn't accepted — the question is still open. Base branch: This field is required."
    ])
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    expect(h.updated).toEqual([])

    await h.daemon.permissions.submitElicitForm({ requestId, fields: submitFields('main') })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })
  })

  it('refuses one bad field, names it in the thread, and does NOT resolve the request', async () => {
    const h = slackTurn()
    const { requestId, result } = await raise(h, form(TWO, ['branch']))
    let settled = false
    void result.then(() => (settled = true))
    await h.daemon.permissions.submitElicitForm({ requestId, fields: submitFields('main', 'x'.repeat(50)) })
    expect(h.notices()[0]).toContain('note: Enter some text, at most 20 characters long.')
    expect(settled).toBe(false)
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    await h.daemon.permissions.releaseElicits('agent-1', 's1')
    await expect(result).resolves.toEqual({ action: 'cancel' })
  })

  it('Dismiss on the card declines it without any field being read', async () => {
    const h = slackTurn()
    const { requestId, result } = await raise(h, form(TWO, ['branch']))
    await h.daemon.permissions.handleElicitChoice({ requestId, value: null, actor: { userId: 'U-BOB' } })
    await expect(result).resolves.toEqual({ action: 'decline' })
  })

  it('settles once when two readers Confirm, and the second finds nothing to answer', async () => {
    const h = slackTurn()
    const { requestId, result } = await raise(h, form(TWO, ['branch']))
    await h.daemon.permissions.submitElicitForm({ requestId, fields: submitFields('main'), actor: { userId: 'U-A' } })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })
    await h.daemon.permissions.submitElicitForm({
      requestId,
      fields: submitFields('develop'),
      actor: { userId: 'U-B' }
    })
    // One resolution only: the accepted content is still the first reader's.
    expect(h.updated).toHaveLength(1)
  })

  it('declines with a notice, and posts no card, when no card can hold the form', async () => {
    const h = slackTurn()
    // A minimum length no Slack input holds — a field the card genuinely cannot render.
    const req = form({ a: { type: 'string', minLength: 3500 }, note: { type: 'string' } }, ['a'])
    await expect(h.daemon.permissions.onAcpElicit('agent-1', 's1', req)).resolves.toBeUndefined()
    expect(h.daemon.permissions.pendingElicits.size).toBe(0)
    expect(h.posted).toEqual([])
    expect(h.notices()[0]).toContain("this chat can't collect an answer for")
  })
})

describe('both Slack ingress paths settle a form card the same way', () => {
  it('a relay-forwarded Confirm carries the fields and settles the identical request', async () => {
    const h = slackTurn()
    const { requestId, result } = await raise(h, form(TWO, ['branch']))
    const agent = { id: 'agent-1', integrations: [{ id: 'int-a', platform: 'slack', core: { mode: 'shared' } }] }
    h.daemon.agents = new Map([['agent-1', agent]])
    h.daemon.connByIntegration = new Map([['int-a', h.conn]])
    h.daemon.store.getSession = async () => ({ key: 'k1', agentId: 'agent-1', platform: 'slack' })
    const relay = (payload: unknown, msgId: string) =>
      h.daemon.handleRelaySlackAction({
        agentId: 'agent-1',
        sessionKey: 'k1',
        msgId,
        botId: 'shared-bot',
        integrationId: 'int-a',
        userId: 'U-ALICE',
        payload
      })

    // A refused field leaves the card live and says so in the thread; the ack carries no verdict,
    // because there is no modal on the far side waiting for one.
    expect(
      await relay({ kind: 'elicitation-confirm', requestId, fields: submitFields('main', 'x'.repeat(50)) }, 'a-bad')
    ).toEqual({ msgId: 'a-bad', accepted: true })
    expect(h.notices()[0]).toContain('note: Enter some text, at most 20 characters long.')
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)

    expect(await relay({ kind: 'elicitation-confirm', requestId, fields: submitFields('main') }, 'a-ok')).toEqual({
      msgId: 'a-ok',
      accepted: true
    })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })
  })
})

// ── #1794: a value too long for Slack's own caps no longer costs a card ───────────────────────

/** Three enum values that are paths, each past Slack's 75-character option-value cap. */
const LONG_PATHS = [
  `packages/daemon/src/${'a'.repeat(70)}.ts`,
  `packages/daemon/src/${'b'.repeat(70)}.ts`,
  `packages/daemon/src/${'c'.repeat(70)}.ts`
]

describe('an option value past what Slack carries', () => {
  it('renders the multi-select anyway, and maps the picks back to the real values', async () => {
    const req = form({ files: { type: 'array', items: { type: 'string', enum: LONG_PATHS } } }, ['files'])
    // The reduction used to refuse the property outright, so the whole form declined on Slack
    // while it rendered on webchat.
    const targets = elicitForm(req, SLACK_ELICIT_SURFACE)
    expect(targets).not.toBeNull()

    const h = slackTurn()
    const { requestId, result } = await raise(h, req)
    const card = h.posted[0] as any[]
    expect(slackCardViolations(card)).toEqual([])
    const values = inputsOf(card)[0]!.element.options.map((o: any) => o.value as string)
    expect(values).toEqual([elicitOptionToken(0), elicitOptionToken(1), elicitOptionToken(2)])
    // The labels are the reader's half of the card and still name the option, clamped to the 75
    // characters a Slack label holds — it is only the WIRE value that stopped carrying it.
    expect(inputsOf(card)[0]!.element.options[0].text.text).toBe(`${LONG_PATHS[0]!.slice(0, 74)}…`)

    await h.daemon.permissions.submitElicitForm({
      requestId,
      fields: { [elicitFormBlockId(0)]: [elicitOptionToken(2), elicitOptionToken(0)] }
    })
    // #1815 intact: the answer is still re-derived against the card — just through the mapping.
    await expect(result).resolves.toEqual({
      action: 'accept',
      content: { files: [LONG_PATHS[2], LONG_PATHS[0]] }
    })
  })

  it('refuses a card value that names no option the field offered', async () => {
    const h = slackTurn()
    const { requestId, result } = await raise(h, form(TWO, ['branch']))
    let settled = false
    void result.then(() => (settled = true))
    // A literal where a position belongs, and a position past the list: neither is an answer.
    await h.daemon.permissions.submitElicitForm({ requestId, fields: { [elicitFormBlockId(0)]: 'develop' } })
    await h.daemon.permissions.submitElicitForm({ requestId, fields: { [elicitFormBlockId(0)]: elicitOptionToken(9) } })
    expect(h.notices()).toHaveLength(2)
    expect(h.notices()[0]).toContain('Base branch: Choose one of the options offered.')
    expect(settled).toBe(false)
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    await h.daemon.permissions.releaseElicits('agent-1', 's1')
    await expect(result).resolves.toEqual({ action: 'cancel' })
  })

  it('keeps a one-tap card answerable when its enum value outruns a button value', async () => {
    const huge = 'x'.repeat(2_100)
    const h = slackTurn()
    const { requestId, result } = await raise(h, form({ pick: { type: 'string', enum: [huge, 'no'] } }, ['pick']))
    const buttons = (h.posted[0] as any[])[1].elements as any[]
    expect(slackCardViolations(h.posted[0] as any[])).toEqual([])
    // The whole message used to be rejected by Slack, so the card never appeared at all.
    expect(buttons[0].value).toBe(`${requestId}|${elicitOptionToken(0)}`)
    await h.daemon.permissions.handleElicitChoice({ requestId, value: elicitOptionToken(0) })
    await expect(result).resolves.toEqual({ action: 'accept', content: { pick: huge } })
  })
})

/** A URL that fits `elicitUrl`'s 2048 but not a Slack button's 2000 — a long OAuth `state`. */
const LONG_URL = `https://auth.example.com/authorize?state=${'s'.repeat(1_960)}`

const urlAsk = (url: string): CreateElicitationRequest =>
  ({
    sessionId: 's1',
    mode: 'url',
    message: 'Sign in to continue',
    url,
    elicitationId: 'e-1'
  }) as unknown as CreateElicitationRequest

describe('a consent URL past what a Slack button carries', () => {
  it('still posts the card, and the tap is still consent for that exact URL', async () => {
    expect(LONG_URL.length).toBeGreaterThan(1_989)
    expect(LONG_URL.length).toBeLessThanOrEqual(2_048)
    const h = slackTurn()
    const { requestId, result } = await raise(h, urlAsk(LONG_URL))
    // It used to fall back to the decline notice with no card at all.
    expect(h.notices()).toEqual([])
    expect(slackCardViolations(h.posted[0] as any[])).toEqual([])
    const open = (h.posted[0] as any[])[2].elements[0]
    expect(open.url).toBe(LONG_URL)
    expect(open.value).toBe(`${requestId}|${elicitOptionToken(0)}`)

    await h.daemon.permissions.handleElicitChoice({ requestId, value: elicitOptionToken(0) })
    await expect(result).resolves.toEqual({ action: 'accept' })
    expect(JSON.stringify(h.updated[0])).toContain('Opened')
  })

  it("takes nothing but that card's own option as consent", async () => {
    const h = slackTurn()
    const { requestId, result } = await raise(h, urlAsk(LONG_URL))
    let settled = false
    void result.then(() => (settled = true))
    // The URL itself is no longer what comes back, so it is not consent either.
    await h.daemon.permissions.handleElicitChoice({ requestId, value: LONG_URL })
    expect(settled).toBe(false)
    await h.daemon.permissions.handleElicitChoice({ requestId, value: null })
    await expect(result).resolves.toEqual({ action: 'decline' })
  })
})

describe('a card settled while its own post is still in flight', () => {
  it('says how it ended rather than calling an accepted consent cancelled', async () => {
    const h = slackTurn()
    let releasePost: () => void = () => {}
    const held = new Promise<void>((resolve) => (releasePost = resolve))
    h.conn.postBlocks = async (_c: string, blocks: unknown[]) => {
      h.posted.push(blocks)
      await held
      return 'ts-1'
    }
    const result = h.daemon.permissions.onAcpElicit('agent-1', 's1', urlAsk('https://auth.example.com/go'))
    await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.size).toBe(1))
    const requestId = [...h.daemon.permissions.pendingElicits.keys()][0] as string
    // Slack can deliver the tap before it has answered the post that carried it — the card has
    // no `ts` yet, so nothing can be rewritten at settlement time.
    await h.daemon.permissions.handleElicitChoice({ requestId, value: elicitOptionToken(0) })
    expect(h.updated).toEqual([])

    releasePost()
    await expect(result).resolves.toEqual({ action: 'accept' })
    await vi.waitFor(() => expect(h.updated).toHaveLength(1))
    // The channel record has to agree with the credential page the reader really did open.
    expect(JSON.stringify(h.updated[0])).toContain('Opened')
    expect(JSON.stringify(h.updated[0])).not.toContain('Cancelled')
  })
})

// ── #1794: the card survives a page reload, and is never re-fed to the runtime ────────────────

describe('a card recorded in the transcript', () => {
  const rows = (h: Harness) => h.daemon.store.upsertElicit.mock.calls.map((c: any[]) => c[0])
  const bodies = (h: Harness) => rows(h).map((r: any) => JSON.parse(r.body))

  it('records the ask, then rewrites the SAME row with how it ended', async () => {
    const h = slackTurn()
    const { requestId, result } = await raise(h, form(TWO, ['branch']))
    expect(bodies(h)[0]).toMatchObject({
      requestId,
      message: 'How should I cut the release?',
      fields: [
        { propName: 'branch', label: 'Base branch', kind: 'enum' },
        { propName: 'note', kind: 'text' }
      ]
    })
    // The reduced card only — the raw requestedSchema is absent here for the same reason it
    // never reaches a wire.
    expect(bodies(h)[0]).not.toHaveProperty('requestedSchema')
    expect(bodies(h)[0].outcome).toBeUndefined()

    await h.daemon.permissions.submitElicitForm({ requestId, fields: submitFields('develop') })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    // One row, rewritten: same coordinates, now carrying the outcome and what was answered.
    expect(rows(h)[1].ts).toBe(rows(h)[0].ts)
    expect(rows(h)[1].channel).toBe('C1')
    expect(rows(h)[1].sender).toBe('agent-1')
    expect(bodies(h)[1]).toMatchObject({ outcome: 'accepted', answerLabel: 'Base branch: develop' })
  })

  it('records a cancelled card as cancelled, and a dismissed one as dismissed', async () => {
    const h = slackTurn()
    const dismissed = await raise(h, form(TWO, ['branch']))
    await h.daemon.permissions.handleElicitChoice({ requestId: dismissed.requestId, value: null })
    await expect(dismissed.result).resolves.toEqual({ action: 'decline' })
    expect(bodies(h).at(-1)).toMatchObject({ outcome: 'dismissed' })

    const abandoned = await raise(h, form(TWO, ['branch']))
    await h.daemon.permissions.releaseElicits('agent-1', 's1')
    await expect(abandoned.result).resolves.toEqual({ action: 'cancel' })
    expect(bodies(h).at(-1)).toMatchObject({ outcome: 'cancelled' })
    // Two cards, two rows — the second never rewrote the first.
    expect(new Set(rows(h).map((r: any) => r.ts)).size).toBe(2)
  })

  it('records an ask nothing could show, which was previously only a live notice', async () => {
    const h = slackTurn()
    const req = form({ when: { type: 'string', minLength: 3500 } }, ['when'])
    await expect(h.daemon.permissions.onAcpElicit('agent-1', 's1', req)).resolves.toBeUndefined()
    expect(h.notices()[0]).toContain("this chat can't collect an answer for")
    expect(bodies(h)).toHaveLength(1)
    expect(bodies(h)[0]).toMatchObject({
      message: 'How should I cut the release?',
      options: [],
      outcome: 'unrenderable'
    })
  })
})

// ── #1794 review: a card outlives the daemon that posted it ───────────────────────────────────

describe('a stale card cannot answer the request that reused its id', () => {
  it("a tap from one daemon's card settles nothing on the next daemon's", async () => {
    const before = slackTurn()
    const staging = await raise(before, form({ env: { type: 'string', enum: ['staging', 'canary'] } }, ['env']))
    // The button's own wire value, exactly as Slack would hand it back — and Slack keeps that
    // message, and its buttons, long after the daemon that posted it is gone.
    const staleValue = (before.posted[0] as any[])[1].elements[0].value as string
    const stale = decodePermValue(staleValue)!
    expect(stale.requestId).toBe(staging.requestId)
    expect(stale.optionId).toBe(elicitOptionToken(0))

    // A restart, and a fresh daemon that asks a DIFFERENT question.
    const after = slackTurn()
    const production = await raise(after, form({ env: { type: 'string', enum: ['production', 'rollback'] } }, ['env']))
    let settled = false
    void production.result.then(() => (settled = true))

    // Tapping the stale card must not answer the new request. A process-local sequence handed
    // both requests the same id, and the card carries a POSITION, so this tap used to accept
    // `production` — an answer to a question this reader never saw.
    await after.daemon.permissions.handleElicitChoice({ requestId: stale.requestId, value: stale.optionId })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(after.daemon.permissions.pendingElicits.size).toBe(1)
    // Which is only true because an id is unique across daemon lifetimes.
    expect(production.requestId).not.toBe(staging.requestId)

    await after.daemon.permissions.handleElicitChoice({
      requestId: production.requestId,
      value: elicitOptionToken(0)
    })
    await expect(production.result).resolves.toEqual({ action: 'accept', content: { env: 'production' } })
  })

  it('mints an id no card can guess and no restart can repeat', async () => {
    const h = slackTurn()
    const first = await raise(h, form({ a: { type: 'string', enum: ['x', 'y'] } }, ['a']))
    await h.daemon.permissions.handleElicitChoice({ requestId: first.requestId, value: null })
    await expect(first.result).resolves.toEqual({ action: 'decline' })
    const second = await raise(h, form({ a: { type: 'string', enum: ['x', 'y'] } }, ['a']))
    for (const id of [first.requestId, second.requestId]) expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(second.requestId).not.toBe(first.requestId)
  })
})
