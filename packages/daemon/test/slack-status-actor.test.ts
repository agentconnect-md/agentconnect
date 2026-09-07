/**
 * A status-bar tap is the one session change with no author in the transcript: the
 * payload names the session, never the person. These pin that the Block Kit
 * `body.user` reaches the daemon callbacks, so "who cancelled this turn" stays
 * answerable — and that a payload without a user degrades to an absent actor
 * rather than a fabricated one.
 */
import { describe, it, expect } from 'vitest'
import { SlackConnection } from '../src/slack/connection.js'
import {
  STATUS_ACTION,
  ELICIT_CONFIRM_ACTION,
  ELICIT_SELECT_ACTION,
  PERMISSION_ACTION_PREFIX,
  encodePermValue
} from '../src/slack/render.js'

type ActionArgs = {
  ack: () => Promise<void>
  action: {
    action_id?: string
    block_id?: string
    value?: string
    selected_option?: { value?: string }
    selected_options?: { value?: string }[]
  }
  body?: { view?: { private_metadata?: string }; user?: { id?: string } }
}
type Handler = (args: ActionArgs) => Promise<void> | void

/** A Bolt stand-in: enough surface for `start()` to reach handler registration. */
function fakeApp(actions: Map<string, Handler>) {
  return {
    init: async () => {},
    message: () => {},
    event: () => {},
    action: (id: string | RegExp, handler: Handler) => actions.set(String(id), handler),
    shortcut: () => {},
    start: async () => {},
    stop: async () => {},
    client: { auth: { test: async () => ({ user_id: 'UBOT', bot_id: 'BBOT', url: 'https://x.slack.test/' }) } }
  } as never
}

async function connect(deps: Record<string, unknown>): Promise<Map<string, Handler>> {
  const actions = new Map<string, Handler>()
  const conn = new SlackConnection(
    {
      group: { appToken: 'xapp-test', botToken: 'xoxb-test', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 't',
      sendIntervalMs: 0,
      ...deps
    } as never,
    () => fakeApp(actions)
  )
  await conn.start()
  return actions
}

const ack = async () => {}

describe('slack status actions carry the acting user', () => {
  it('reports the tapping user for cancel', async () => {
    const seen: unknown[] = []
    const actions = await connect({ onStatusAction: (a: unknown) => seen.push(a) })

    await actions.get(STATUS_ACTION.cancel)!({
      ack,
      action: { value: 'slack:C1:T1:bot-a' },
      body: { user: { id: 'U-ALICE' } }
    })

    expect(seen).toEqual([{ kind: 'cancel', sessionKey: 'slack:C1:T1:bot-a', actor: { userId: 'U-ALICE' } }])
  })

  it('reports the tapping user for a permission-card choice', async () => {
    const seen: unknown[] = []
    const actions = await connect({ onPermissionChoice: (a: unknown) => seen.push(a) })
    const handler = [...actions.entries()].find(([id]) => id.includes(PERMISSION_ACTION_PREFIX))![1]

    await handler({
      ack,
      action: { value: encodePermValue('req-1', 'allow_always') },
      body: { user: { id: 'U-BOB' } }
    })

    expect(seen).toEqual([{ requestId: 'req-1', optionId: 'allow_always', actor: { userId: 'U-BOB' } }])
  })

  // A multi-select card is two interactions: the select re-sends the whole current selection on
  // every change, its own action_id naming the request, and Confirm submits what was seen.
  it('reports a multi-select card’s whole selection, then its Confirm', async () => {
    const selected: unknown[] = []
    const confirmed: unknown[] = []
    const actions = await connect({
      onElicitSelect: (a: unknown) => selected.push(a),
      onElicitConfirm: (a: unknown) => confirmed.push(a)
    })
    const select = [...actions.entries()].find(([id]) => id.includes(`${ELICIT_SELECT_ACTION}:`))![1]

    await select({
      ack,
      action: {
        action_id: `${ELICIT_SELECT_ACTION}:elicit-9`,
        selected_options: [{ value: 'lint' }, { value: 'test' }]
      },
      body: { user: { id: 'U-CAROL' } }
    })
    // Deselecting everything is a change too, and the action_id still names the card.
    await select({ ack, action: { action_id: `${ELICIT_SELECT_ACTION}:elicit-9`, selected_options: [] }, body: {} })
    // An option Slack sent without a value would make the list lie about what is selected.
    await select({ ack, action: { action_id: `${ELICIT_SELECT_ACTION}:elicit-9`, selected_options: [{}] }, body: {} })
    expect(selected).toEqual([
      { requestId: 'elicit-9', values: ['lint', 'test'], actor: { userId: 'U-CAROL' } },
      { requestId: 'elicit-9', values: [], actor: undefined }
    ])

    await actions.get(ELICIT_CONFIRM_ACTION)!({ ack, action: { value: 'elicit-9' }, body: { user: { id: 'U-DAN' } } })
    expect(confirmed).toEqual([{ requestId: 'elicit-9', actor: { userId: 'U-DAN' } }])
  })

  it('leaves the actor absent when the payload names no user', async () => {
    const seen: { actor?: { userId: string } }[] = []
    const actions = await connect({ onStatusAction: (a: never) => seen.push(a) })

    await actions.get(STATUS_ACTION.setModel)!({
      ack,
      action: { block_id: 'slack:C1:T1:bot-a', selected_option: { value: 'opus' } },
      body: {}
    })

    expect(seen[0]!.actor).toBeUndefined()
  })
})
