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
  PERMISSION_ACTION_PREFIX,
  elicitFormBlockId,
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
  body?: {
    trigger_id?: string
    view?: { private_metadata?: string }
    user?: { id?: string }
    state?: { values?: Record<string, Record<string, unknown>> }
  }
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

  // A form card's Confirm reads every field out of its OWN payload's message state (Slack has
  // carried full state on `block_actions` since 2020-09-01), so what reaches the daemon is the
  // state THIS reader tapped Confirm on — nothing is kept between interactions. An `input` block
  // raises no interaction of its own, so Confirm is the only handler this card needs.
  it('reports the fields a Confirm’s own payload carried, keyed by block id', async () => {
    const submitted: unknown[] = []
    const actions = await connect({ onElicitFormSubmit: (a: unknown) => submitted.push(a) })
    const stateWith = (values: Record<string, Record<string, unknown>>) => ({ values })
    const confirm = (state?: ReturnType<typeof stateWith>, user?: string) =>
      actions.get(ELICIT_CONFIRM_ACTION)!({
        ack,
        action: { value: 'elicit-9' },
        body: { ...(state !== undefined ? { state } : {}), ...(user ? { user: { id: user } } : {}) }
      })

    await confirm(
      stateWith({
        [elicitFormBlockId(0)]: { ac_elicit_input: { selected_option: { value: 'main' } } },
        [elicitFormBlockId(1)]: { ac_elicit_input: { value: 'ship it' } },
        [elicitFormBlockId(2)]: { ac_elicit_input: { selected_options: [{ value: 'lint' }] } },
        // A blank input is OMITTED, which is what an untouched optional field means.
        [elicitFormBlockId(3)]: { ac_elicit_input: { value: null } },
        // Neither another block nor another action inside one of ours is this card's field.
        not_ours: { ac_elicit_input: { value: 'injected' } }
      }),
      'U-DAN'
    )
    // An emptied select is a real answer; a Confirm with no state at all submits nothing, and
    // the daemon refuses it against the card's own `required` set.
    await confirm(stateWith({ [elicitFormBlockId(0)]: { ac_elicit_input: { selected_options: [] } } }), 'U-ERIN')
    await confirm()
    expect(submitted).toEqual([
      {
        requestId: 'elicit-9',
        fields: {
          [elicitFormBlockId(0)]: 'main',
          [elicitFormBlockId(1)]: 'ship it',
          [elicitFormBlockId(2)]: ['lint']
        },
        actor: { userId: 'U-DAN' }
      },
      { requestId: 'elicit-9', fields: { [elicitFormBlockId(0)]: [] }, actor: { userId: 'U-ERIN' } },
      { requestId: 'elicit-9', fields: {} }
    ])
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
