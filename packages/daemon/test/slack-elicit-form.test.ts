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
  elicitFormBlockId,
  elicitFormSubmission,
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
    expect(inputs[0]!.element.options.map((o: any) => o.value)).toEqual(['main', 'develop'])
    // `minItems` has no Slack attribute — and `checkboxes` has no `max_selected_items` at all —
    // so the bounds are said as a hint and enforced when the answer comes back.
    expect(inputs[1]!.hint.text).toBe('Select at least 1.')
    expect(inputs[1]!.element.max_selected_items).toBeUndefined()
    expect(inputs[2]!.element.max_length).toBe(20)
    expect(inputs[2]!.hint.text).toBe('Anything the reviewer should know')
    expect(inputs[3]!.element).toMatchObject({ is_decimal_allowed: false, min_value: '1', max_value: '9' })
    // A boolean's `default` seeds the control with the option that spells it.
    expect(inputs[4]!.element.initial_option.value).toBe('true')
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
    // Slack caps a select option's `value` at 75 characters and an input block has no button to
    // fall back to (#1813's finding, one surface on).
    const long = 'x'.repeat(80)
    const req = form({ branch: { type: 'string', enum: [long, 'dev'] }, note: { type: 'string' } }, ['branch'])
    expect(elicitForm(req, SLACK_ELICIT_SURFACE)).toHaveLength(2)
    expect(cardFor(req)).toBeNull()
    // And a minimum length no input can hold.
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

describe('a form submission is re-derived against the card that offered it', () => {
  const req = form(EVERY_KIND, ['branch', 'checks'])
  const fields = elicitForm(req, SLACK_ELICIT_SURFACE)!

  it('answers with the typed record — real numbers, arrays, the boolean’s own wire value', () => {
    expect(
      elicitFormSubmission(req, fields, {
        [elicitFormBlockId(0)]: 'main',
        [elicitFormBlockId(1)]: ['lint', 'test'],
        [elicitFormBlockId(2)]: 'ship it',
        [elicitFormBlockId(3)]: '4',
        [elicitFormBlockId(4)]: 'false'
      })
    ).toEqual({ answer: { branch: 'main', checks: ['lint', 'test'], note: 'ship it', count: 4, draft: 'false' } })
  })

  it('accepts an omitted OPTIONAL field and refuses a missing REQUIRED one', () => {
    expect(
      elicitFormSubmission(req, fields, { [elicitFormBlockId(0)]: 'main', [elicitFormBlockId(1)]: ['lint'] })
    ).toEqual({ answer: { branch: 'main', checks: ['lint'] } })
    expect(elicitFormSubmission(req, fields, { [elicitFormBlockId(0)]: 'main' })).toEqual({
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
      elicitFormSubmission(optional, target, { [elicitFormBlockId(0)]: 'main', [elicitFormBlockId(1)]: [] })
    ).toEqual({ answer: { branch: 'main' } })
    // A REQUIRED one keeps its own bounds: there an empty selection is a real answer to judge.
    const needed = form({ checks: { type: 'array', minItems: 1, items: EVERY_KIND.checks.items } }, ['checks'])
    const neededTarget = elicitForm(needed, SLACK_ELICIT_SURFACE)!
    expect(elicitFormSubmission(needed, neededTarget, { [elicitFormBlockId(0)]: [] }).errors).toBeDefined()
  })

  it('refuses ONE bad field with that field’s own error, rather than dropping it', () => {
    const bad = elicitFormSubmission(req, fields, {
      [elicitFormBlockId(0)]: 'trunk', // never offered
      [elicitFormBlockId(1)]: ['lint'],
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
        [elicitFormBlockId(0)]: ['main'], // a list cannot answer a single select
        [elicitFormBlockId(1)]: ['lint']
      }).errors
    ).toEqual({ [elicitFormBlockId(0)]: 'Choose one of the options offered.' })
    expect(
      elicitFormSubmission(req, fields, {
        [elicitFormBlockId(0)]: 'main',
        [elicitFormBlockId(1)]: ['lint'],
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
    resolvePermissionRequest: vi.fn(() => true)
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

const submitFields = (branch: string, note?: string) => ({
  [elicitFormBlockId(0)]: branch,
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
    const long = 'x'.repeat(80)
    const req = form({ branch: { type: 'string', enum: [long, 'dev'] }, note: { type: 'string' } }, ['branch'])
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
