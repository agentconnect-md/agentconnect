/**
 * Discord's elicitation card — the third implementer of the Layer-2 elicitation-card facet
 * (#1794). Discord is the first surface that can put a WHOLE FORM in front of the reader as one
 * dialog: a message takes buttons but no typed box, while a modal takes `Label`-wrapped text
 * inputs and select menus, so everything but a one-tap question is answered in a modal.
 */
import { describe, it, expect, vi } from 'vitest'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { elicitFormBlockId } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { DiscordConnection } from '../src/discord/connection.js'
import type { DiscordComponents } from '../src/discord/render.js'
import { elicitForm, elicitOptionToken, elicitTarget } from '../src/slack/render.js'
import {
  DISCORD_ELICIT_SURFACE,
  DISCORD_MODAL_MAX_FIELDS,
  buildDiscordElicitModal,
  discordElicitButtons,
  discordElicitId,
  discordUsesModal,
  parseDiscordElicit
} from '../src/platforms/discord/elicit-card.js'

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

/** The one Label wrapping field `index`, as the modal built it. */
function field(modal: any, index: number): any {
  return modal.components[index]
}

describe('the wire a Discord elicitation comes back on', () => {
  it("fits Discord's 100-character custom_id for the widest card this scheme can mint", () => {
    expect(discordElicitId(REQUEST_ID, elicitOptionToken(24)).length).toBeLessThanOrEqual(100)
    expect(parseDiscordElicit(discordElicitId(REQUEST_ID, elicitOptionToken(3)))).toEqual({
      requestId: REQUEST_ID,
      token: elicitOptionToken(3)
    })
    // Dismiss is no answer, so it decodes as none.
    expect(parseDiscordElicit(discordElicitId(REQUEST_ID, 'x'))).toEqual({ requestId: REQUEST_ID, token: null })
    // The session-control cards' own schemes, which this decoder must never claim.
    expect(parseDiscordElicit('ac_sel:m:2')).toBeNull()
    expect(parseDiscordElicit('ac_cb:cancel')).toBeNull()
    expect(parseDiscordElicit('')).toBeNull()
  })

  it('lays a one-tap card out five buttons to a row, each holding a POSITION', () => {
    const rows = discordElicitButtons(
      REQUEST_ID,
      Array.from({ length: 6 }, (_, i) => ({ label: `o${i}` }))
    )
    // Six options plus Dismiss = seven buttons over two rows, since a row holds five.
    expect(rows.map((r) => r.components.length)).toEqual([5, 2])
    expect(rows[0]!.components[0]!.custom_id).toBe(discordElicitId(REQUEST_ID, elicitOptionToken(0)))
    expect(rows[1]!.components.at(-1)!.label).toBe('Dismiss')
  })
})

describe('what Discord declares it can collect, and which card collects it', () => {
  it('claims every kind, because the dialog has a control for every kind', () => {
    expect([...DISCORD_ELICIT_SURFACE.kinds].sort()).toEqual(['boolean', 'enum', 'multi-enum', 'number', 'text'])
  })

  it('answers a lone single-select or boolean with a tap, and everything else in the dialog', () => {
    expect(discordUsesModal(elicitForm(form(BRANCH), DISCORD_ELICIT_SURFACE)!)).toBe(false)
    expect(discordUsesModal(elicitForm(form({ ok: { type: 'boolean' } }), DISCORD_ELICIT_SURFACE)!)).toBe(false)
    expect(discordUsesModal(elicitForm(form(CHECKS), DISCORD_ELICIT_SURFACE)!)).toBe(true)
    expect(discordUsesModal(elicitForm(form({ note: { type: 'string' } }), DISCORD_ELICIT_SURFACE)!)).toBe(true)
    expect(discordUsesModal(elicitForm(form({ ...BRANCH, ...CHECKS }), DISCORD_ELICIT_SURFACE)!)).toBe(true)
  })

  it('reduces every kind rather than dropping one, a typed field included', () => {
    expect(elicitTarget(form(BRANCH), DISCORD_ELICIT_SURFACE)?.kind).toBe('enum')
    expect(elicitTarget(form(CHECKS), DISCORD_ELICIT_SURFACE)?.kind).toBe('multi-enum')
    expect(elicitTarget(form({ note: { type: 'string' } }), DISCORD_ELICIT_SURFACE)?.kind).toBe('text')
    expect(elicitTarget(form({ n: { type: 'integer' } }), DISCORD_ELICIT_SURFACE)?.kind).toBe('number')
  })
})

describe('the dialog one reduction becomes', () => {
  const build = (params: CreateElicitationRequest) =>
    buildDiscordElicitModal(REQUEST_ID, params, elicitForm(params, DISCORD_ELICIT_SURFACE)!)

  it('wraps each field in a Label carrying the control that collects it', () => {
    const params = form({ ...CHECKS, note: { type: 'string', title: 'Notes' } }, ['checks'])
    const modal = build(params)!
    expect(modal.custom_id).toBe(discordElicitId(REQUEST_ID, 'm'))
    expect(modal.components).toHaveLength(2)

    // A multi-select is one select menu, bounded by its own field rather than by the control.
    const checks = field(modal, 0)
    expect(checks.type).toBe(18)
    expect(checks.label).toBe('Checks')
    expect(checks.component.type).toBe(3)
    expect(checks.component.custom_id).toBe(elicitFormBlockId(0))
    expect(checks.component.max_values).toBe(2)
    // Required, so at least one; every option carries its POSITION and never its own value.
    expect(checks.component.min_values).toBe(1)
    expect(checks.component.options.map((o: any) => o.value)).toEqual([elicitOptionToken(0), elicitOptionToken(1)])
    expect(checks.component.options.map((o: any) => o.label)).toEqual(['lint', 'test'])

    // A typed field is a text input, and this one is optional.
    const note = field(modal, 1)
    expect(note.component.type).toBe(4)
    expect(note.component.custom_id).toBe(elicitFormBlockId(1))
    expect(note.component.required).toBe(false)
  })

  it('lets an optional select take nothing, which is how a field stays omittable', () => {
    const modal = build(form(CHECKS))!
    expect(field(modal, 0).component.min_values).toBe(0)
  })

  it('has no dialog for more fields than a modal holds, and declines rather than dropping one', () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i <= DISCORD_MODAL_MAX_FIELDS; i++) many[`f${i}`] = { type: 'string' }
    expect(build(form(many))).toBeNull()
    const fits: Record<string, unknown> = {}
    for (let i = 0; i < DISCORD_MODAL_MAX_FIELDS; i++) fits[`f${i}`] = { type: 'string' }
    expect(build(form(fits))).not.toBeNull()
  })
})

// -- the coordinator, on a Discord turn ------------------------------------------------------

interface Harness {
  daemon: any
  conn: any
  cards: { text: string; components: DiscordComponents }[]
  edits: { text: string; components?: DiscordComponents }[]
  notices: () => string[]
}

function discordTurn(): Harness {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: () => new Map(),
    upsertElicit: vi.fn(async () => {})
  }
  const cards: { text: string; components: DiscordComponents }[] = []
  const edits: { text: string; components?: DiscordComponents }[] = []
  const conn = Object.create(DiscordConnection.prototype)
  conn.postChrome = async (_c: string, text: string, opts: { keyboard?: DiscordComponents } = {}) => {
    cards.push({ text, components: opts.keyboard ?? [] })
    return '4242'
  }
  conn.updateMessage = async (_c: string, _id: string, text: string, opts: { keyboard?: DiscordComponents } = {}) => {
    edits.push({ text, ...(opts.keyboard !== undefined ? { components: opts.keyboard } : {}) })
  }
  daemon.pending.set(JSON.stringify(['agent-1', 's1']), {
    plan: {
      platform: 'discord',
      agentId: 'agent-1',
      sessionKey: 'k1',
      requesterId: 'turn-user',
      channel: 'C1',
      transcriptChannel: 'C1discord:bot-a',
      statusThread: 'T1',
      agentName: 'agent',
      isDm: false,
      approvalSurfaceSuppressed: false
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
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.get(requestId).ts).toBe('4242'))
  return { requestId, result }
}

describe('a Discord turn posts an elicitation card and settles it in place', () => {
  it('answers a lone single-select with one tap, and never opens a dialog for it', async () => {
    const h = discordTurn()
    const { requestId, result } = await raise(h, form(BRANCH, ['branch']))
    expect(h.cards[0]!.text).toBe('💬 Which branch should I cut from?')
    expect(h.cards[0]!.components[0]!.components.map((b) => b.label)).toEqual(['main', 'develop', 'Dismiss'])
    // There is no dialog behind a card one tap answers.
    expect(h.daemon.permissions.openElicitEditor(requestId)).toBeUndefined()

    await h.daemon.permissions.handleElicitCardTap({ requestId, token: elicitOptionToken(1) })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    expect(h.edits[0]!.text).toBe('💬 Which branch should I cut from?\n✅ develop')
    // Nothing is left to press on an answered card.
    expect(h.edits[0]!.components).toEqual([])
  })

  it('opens the dialog for everything else, and takes the whole form back at once', async () => {
    const h = discordTurn()
    const params = form({ ...CHECKS, note: { type: 'string', title: 'Notes' } }, ['checks'])
    const { requestId, result } = await raise(h, params)
    // The card itself only offers the way in — the answer never passes through the message.
    expect(h.cards[0]!.components[0]!.components.map((b) => b.label)).toEqual(['Answer', 'Dismiss'])
    const modal = h.daemon.permissions.openElicitEditor(requestId) as any
    expect(modal.custom_id).toBe(discordElicitId(requestId, 'm'))

    await h.daemon.permissions.submitElicitEditor({
      requestId,
      values: { [elicitFormBlockId(0)]: [elicitOptionToken(1)], [elicitFormBlockId(1)]: 'ship it' }
    })
    await expect(result).resolves.toEqual({ action: 'accept', content: { checks: ['test'], note: 'ship it' } })
    expect(h.edits.at(-1)!.text).toContain('Checks: test')
  })

  it('reads a single-valued control list as the one value it holds', async () => {
    // A select answers with a list even where it was configured to take one; the FIELD says which.
    const h = discordTurn()
    const { requestId, result } = await raise(h, form({ ...BRANCH, ...CHECKS }, ['branch']))
    await h.daemon.permissions.submitElicitEditor({
      requestId,
      values: { [elicitFormBlockId(0)]: [elicitOptionToken(0)], [elicitFormBlockId(1)]: [] }
    })
    // And an untouched optional select is an OMISSION, not an empty answer.
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })
  })

  it('refuses a dialog missing a required field, and leaves the card live', async () => {
    const h = discordTurn()
    const { requestId } = await raise(h, form({ ...CHECKS, note: { type: 'string' } }, ['checks']))
    await h.daemon.permissions.submitElicitEditor({
      requestId,
      values: { [elicitFormBlockId(1)]: 'ship it' }
    })
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    expect(h.notices().at(-1)).toContain('Checks')
  })

  it('refuses an option position the dialog never offered', async () => {
    const h = discordTurn()
    const { requestId } = await raise(h, form(CHECKS, ['checks']))
    await h.daemon.permissions.submitElicitEditor({
      requestId,
      values: { [elicitFormBlockId(0)]: [elicitOptionToken(9)] }
    })
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    expect(h.notices().at(-1)).toContain("wasn't accepted")
  })

  it('reads Dismiss as the decline it is, on either card', async () => {
    const h = discordTurn()
    const { requestId, result } = await raise(h, form(CHECKS, ['checks']))
    await h.daemon.permissions.handleElicitCardTap({ requestId, token: null })
    await expect(result).resolves.toEqual({ action: 'decline' })
    expect(h.edits.at(-1)!.text).toContain('Dismissed')
  })

  it('declines URL mode, whose consent a Discord link button could never report', async () => {
    const h = discordTurn()
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
    const h = discordTurn()
    const { requestId, result } = await raise(h, form(CHECKS, ['checks']))
    await h.daemon.permissions.releaseElicits('agent-1', 's1')
    await expect(result).resolves.toEqual({ action: 'cancel' })
    expect(h.edits.at(-1)!.text).toContain('Cancelled')
    expect(h.daemon.permissions.openElicitEditor(requestId)).toBeUndefined()
  })
})
