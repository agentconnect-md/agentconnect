// Google Chat's elicitation card: a cardsV2 message on the turn's leased egress, answered by a relay-forwarded click.
import { describe, it, expect, vi } from 'vitest'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { Daemon } from '../src/daemon.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { WorkBoundary } from '../src/messages/message-boundary.js'
import { elicitFormBlockId, type WireGoogleChatCardAction } from '@agentconnect.md/protocol'
import { googleChatEventOf, normalizeGoogleChatEvent } from '@agentconnect.md/message'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { elicitOptionToken } from '../src/slack/render.js'
import {
  buildGoogleChatElicitButtons,
  googleChatCardFunction,
  googleChatElicitCards,
  googleChatElicitClientId,
  parseGoogleChatElicitClick
} from '../src/platforms/googlechat/elicit-card.js'

const AGENT = '22222222-2222-4222-8222-222222222222'
const INTEGRATION = '33333333-3333-4333-8333-333333333333'
const BOT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'spaces/EXAMPLE_SPACE'
const THREAD = `${SPACE}/threads/EXAMPLE_THREAD`
const PERSON = 'users/100000000000000000001'
const EVENTS_URL = 'https://relay.example.test/googlechat/events'

function form(properties: Record<string, unknown>, required: string[] = []): CreateElicitationRequest {
  return {
    sessionId: 's1',
    mode: 'form',
    message: 'Which branch should I cut from?',
    requestedSchema: { type: 'object', properties, required }
  } as CreateElicitationRequest
}

const BRANCH = { branch: { type: 'string', enum: ['main', 'develop'], title: 'Base branch' } }

function googleChatTurn(app: { addOn?: boolean; eventsUrl?: string } = {}) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: PERSON }),
    getDisplayNames: () => new Map(),
    upsertElicit: vi.fn(async () => {})
  }
  daemon.agents.get = (id: string) =>
    id === AGENT ? { id: AGENT, integrations: [{ id: INTEGRATION, platform: 'googlechat' }] } : undefined
  const creates: any[] = []
  const patches: { name: string; cardsV2: any }[] = []
  const egress = {
    ...(app.eventsUrl ? { eventsUrl: app.eventsUrl } : {}),
    createMessage: async (input: any) => {
      creates.push(input)
      return { name: `${SPACE}/messages/card-${creates.length}`, clientId: input.clientId }
    },
    patchMessage: async () => {},
    patchCards: async (name: string, cardsV2: unknown) => void patches.push({ name, cardsV2 })
  }
  daemon.pending.set(JSON.stringify([AGENT, 's1']), {
    plan: {
      platform: 'googlechat',
      agentId: AGENT,
      sessionKey: 'k1',
      channel: SPACE,
      transcriptChannel: SPACE,
      statusThread: THREAD,
      agentName: 'agent',
      isDm: false,
      approvalSurfaceSuppressed: false
    },
    entry: { msg: {} },
    hostKey: AGENT,
    outwardSessionId: 'sess-1',
    egress,
    turnState: {
      conn: egress,
      ...(app.addOn ? { addOn: true } : {}),
      space: SPACE,
      thread: THREAD,
      deliveryId: 'd1',
      block: 0
    },
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
  const click = (payload: unknown, integrationId = INTEGRATION) =>
    daemon.platformActionDecoders.get('googlechat')({
      source: 'platform_action',
      platformId: 'googlechat',
      agentId: AGENT,
      integrationId,
      sessionKey: `googlechat-action:${SPACE}/messages/card-1`,
      msgId: 'googlechat-action:1',
      botId: BOT,
      userId: PERSON,
      payload
    })
  return { daemon, creates, patches, click, notices: () => applied.filter((a) => a.kind === 'notice') }
}

async function raise(h: ReturnType<typeof googleChatTurn>, req: CreateElicitationRequest) {
  const result = h.daemon.permissions.onAcpElicit(AGENT, 's1', req)
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.size).toBe(1))
  const requestId = [...h.daemon.permissions.pendingElicits.keys()][0] as string
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.get(requestId).ts).toBe(`${SPACE}/messages/card-1`))
  return { requestId, result }
}

const elicitClick = (requestId: string, token: string, formInputs: Record<string, string[]> = {}) => ({
  function: 'agentconnect.elicit',
  parameters: { request: requestId, token },
  formInputs,
  message: `${SPACE}/messages/card-1`
})

const texts = (cardsV2: any): string[] =>
  JSON.stringify(cardsV2)
    .match(/"text":"[^"]*"/g)!
    .map((t) => JSON.parse(`{${t}}`).text)

describe('the Google Chat elicitation card', () => {
  it('escapes the agent’s words so they never become card markup', () => {
    const [heading] = texts(buildGoogleChatElicitButtons('r', 'Use <b>x</b> & y\nnext', [{ label: 'a' }]))
    expect(heading).toBe('💬 Use &lt;b&gt;x&lt;/b&gt; &amp; y<br>next')
  })

  it('declines a URL consent card, which reports nothing back', () => {
    const ask = {
      requestId: 'r',
      params: form(BRANCH),
      message: 'm',
      fallback: 'm',
      url: { elicitationId: 'e', url: 'https://example.test' }
    }
    expect(googleChatElicitCards.build({} as never, {} as never, ask)).toBeNull()
  })

  it('reads a click as a choice, a Dismiss, or a Confirm carrying the card’s widgets', () => {
    expect(parseGoogleChatElicitClick(elicitClick('r', 'o1'))).toEqual({ kind: 'choice', requestId: 'r', token: 'o1' })
    expect(parseGoogleChatElicitClick(elicitClick('r', 'x'))).toEqual({ kind: 'choice', requestId: 'r', token: null })
    expect(parseGoogleChatElicitClick(elicitClick('r', 'ok', { f0: ['v'] }))).toEqual({
      kind: 'submit',
      requestId: 'r',
      values: { f0: ['v'] }
    })
    expect(parseGoogleChatElicitClick({ ...elicitClick('r', 'o1'), function: 'agentconnect.claim' })).toBeNull()
    expect(parseGoogleChatElicitClick({ ...elicitClick('r', 'o1'), parameters: { token: 'o1' } })).toBeNull()
  })
})

describe('a Google Chat turn collects an elicitation answer from a card click', () => {
  it('posts a one-tap card in the turn’s thread and settles it from the tapped option', async () => {
    const h = googleChatTurn()
    const { requestId, result } = await raise(h, form(BRANCH, ['branch']))
    expect(h.creates).toHaveLength(1)
    expect(h.creates[0]).toMatchObject({ space: SPACE, thread: THREAD, clientId: googleChatElicitClientId(requestId) })
    expect(texts(h.creates[0].cardsV2)).toEqual(['💬 Which branch should I cut from?', 'main', 'develop', 'Dismiss'])
    await expect(h.click(elicitClick(requestId, elicitOptionToken(1)))).resolves.toMatchObject({ accepted: true })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    await vi.waitFor(() => expect(h.patches).toHaveLength(1))
    expect(h.patches[0]!.name).toBe(`${SPACE}/messages/card-1`)
    expect(texts(h.patches[0]!.cardsV2)).toEqual(['💬 Which branch should I cut from?<br>✅ develop'])
  })

  it('answers a form card from its Confirm and the widgets Google sent with it', async () => {
    const h = googleChatTurn()
    const req = form(
      {
        note: { type: 'string', title: 'Note' },
        envs: { type: 'array', title: 'Environments', items: { type: 'string', enum: ['test', 'prod'] } }
      },
      ['note']
    )
    const { requestId, result } = await raise(h, req)
    const card = JSON.stringify(h.creates[0].cardsV2)
    expect(card).toContain(`"textInput":{"name":"${elicitFormBlockId(0)}"`)
    expect(card).toContain('"type":"CHECK_BOX"')
    await h.click(
      elicitClick(requestId, 'ok', {
        [elicitFormBlockId(0)]: ['ship it'],
        [elicitFormBlockId(1)]: [elicitOptionToken(0), elicitOptionToken(1)]
      })
    )
    await expect(result).resolves.toEqual({ action: 'accept', content: { note: 'ship it', envs: ['test', 'prod'] } })
  })

  it('keeps a form card live when its Confirm leaves a required field empty', async () => {
    const h = googleChatTurn()
    const { requestId } = await raise(h, form({ note: { type: 'string', title: 'Note' } }, ['note']))
    await h.click(elicitClick(requestId, 'ok'))
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
  })

  it('declines on Dismiss', async () => {
    const h = googleChatTurn()
    const { requestId, result } = await raise(h, form(BRANCH, ['branch']))
    await h.click(elicitClick(requestId, 'x'))
    await expect(result).resolves.toEqual({ action: 'decline' })
  })

  it('drops a click for an integration this agent does not have, and a payload that is not a card click', async () => {
    const h = googleChatTurn()
    const { requestId } = await raise(h, form(BRANCH, ['branch']))
    await expect(
      h.click(elicitClick(requestId, elicitOptionToken(1)), '44444444-4444-4444-8444-444444444444')
    ).resolves.toMatchObject({
      accepted: false,
      reason: 'not_found'
    })
    await expect(h.click({ nope: true })).resolves.toMatchObject({ accepted: false, reason: 'unsupported_action' })
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
  })
})

// Every button's `onClick.action` on a posted card.
const actionsOf = (cardsV2: any): { function: string; parameters: { key: string; value: string }[] }[] =>
  cardsV2[0].card.sections[0].widgets.flatMap((w: any) => w.buttonList?.buttons.map((b: any) => b.onClick.action) ?? [])

describe('the Google Chat elicitation card in either app form (§11)', () => {
  it('names the action in a parameter and the function by the form of the app the turn’s message came from', async () => {
    const chat = googleChatTurn({ eventsUrl: EVENTS_URL })
    await raise(chat, form(BRANCH, ['branch']))
    const addOn = googleChatTurn({ addOn: true, eventsUrl: EVENTS_URL })
    await raise(addOn, form(BRANCH, ['branch']))
    for (const [h, fn] of [
      [chat, 'agentconnect.elicit'],
      [addOn, EVENTS_URL]
    ] as const) {
      const actions = actionsOf(h.creates[0].cardsV2)
      expect(actions).toHaveLength(3)
      for (const action of actions) {
        expect(action.function).toBe(fn)
        expect(action.parameters[0]).toEqual({ key: 'agentconnect.action', value: 'agentconnect.elicit' })
      }
    }
  })

  it('declines an add-on’s card while the events URL is unknown, since its buttons could never answer', () => {
    expect(googleChatCardFunction(false, undefined)).toBe('agentconnect.elicit')
    expect(googleChatCardFunction(true, EVENTS_URL)).toBe(EVENTS_URL)
    expect(googleChatCardFunction(true, undefined)).toBeNull()
    const ask = { requestId: 'r', params: form(BRANCH), message: 'm', fallback: 'm', form: [] as never[] }
    const host = (state: unknown) => ({ turnState: () => state }) as never
    const withForm = { ...ask, form: [{ kind: 'enum', key: 'branch', options: [{ label: 'main', value: 'main' }] }] }
    expect(googleChatElicitCards.build(host({ addOn: true, conn: {} }), {} as never, withForm as never)).toBeNull()
    expect(googleChatElicitCards.build(host({ conn: {} }), {} as never, withForm as never)).not.toBeNull()
  })

  it('reads a click back from either request form as the answer the button carried', () => {
    for (const fn of ['agentconnect.elicit', EVENTS_URL]) {
      const [action] = actionsOf(buildGoogleChatElicitButtons('req-1', 'Pick one', [{ label: 'main' }], fn))
      const parameters = Object.fromEntries(action!.parameters.map((p) => [p.key, p.value]))
      const space = { name: SPACE, spaceType: 'SPACE' }
      const message = { name: `${SPACE}/messages/card-1`, thread: { name: THREAD } }
      const user = { name: PERSON, type: 'HUMAN' }
      const chatForm = {
        type: 'CARD_CLICKED',
        space,
        message,
        user,
        action: { actionMethodName: action!.function, parameters: action!.parameters },
        common: { invokedFunction: action!.function, parameters }
      }
      const addOnForm = { commonEventObject: { parameters }, chat: { user, buttonClickedPayload: { space, message } } }
      for (const body of [chatForm, addOnForm]) {
        const result = normalizeGoogleChatEvent(googleChatEventOf(body)!.event, {
          appUserName: 'users/100000000000000000009',
          traceId: 't'
        })
        if (result.kind !== 'interaction') throw new Error(`expected an interaction, got ${result.kind}`)
        const { interaction } = result
        const payload: WireGoogleChatCardAction = {
          function: interaction.function,
          parameters: interaction.parameters,
          formInputs: interaction.formInputs,
          ...(interaction.message ? { message: interaction.message } : {})
        }
        expect(parseGoogleChatElicitClick(payload)).toEqual({
          kind: 'choice',
          requestId: 'req-1',
          token: elicitOptionToken(0)
        })
      }
    }
  })
})
