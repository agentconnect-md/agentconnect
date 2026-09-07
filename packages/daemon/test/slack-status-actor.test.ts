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
  body?: {
    view?: { private_metadata?: string }
    user?: { id?: string }
    state?: { values?: Record<string, Record<string, { selected_options?: { value?: unknown }[] }>> }
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

  // A multi-select card's Confirm reads its selection out of its OWN payload's message state
  // (Slack has carried full state on `block_actions` since 2020-09-01), so what reaches the
  // daemon is the state THIS reader tapped Confirm on — nothing is kept between interactions.
  it('reports the selection a multi-select Confirm’s own payload carried', async () => {
    const confirmed: unknown[] = []
    const actions = await connect({ onElicitConfirm: (a: unknown) => confirmed.push(a) })
    const stateWith = (values: string[], block = 'blk-1') => ({
      values: {
        [block]: { [`${ELICIT_SELECT_ACTION}:elicit-9`]: { selected_options: values.map((value) => ({ value })) } }
      }
    })
    const confirm = (state?: ReturnType<typeof stateWith>, user?: string) =>
      actions.get(ELICIT_CONFIRM_ACTION)!({
        ack,
        action: { value: 'elicit-9' },
        body: { ...(state !== undefined ? { state } : {}), ...(user ? { user: { id: user } } : {}) }
      })

    await confirm(stateWith(['lint', 'test']), 'U-DAN')
    // Found by ACTION id, whichever block Slack grouped the select into.
    await confirm(stateWith(['test'], 'another-block'), 'U-ERIN')
    // An emptied select is a real answer; no state for it is not one, and reaches nothing.
    await confirm(stateWith([]))
    await confirm({ values: {} })
    await confirm()
    expect(confirmed).toEqual([
      { requestId: 'elicit-9', values: ['lint', 'test'], actor: { userId: 'U-DAN' } },
      { requestId: 'elicit-9', values: ['test'], actor: { userId: 'U-ERIN' } },
      { requestId: 'elicit-9', values: [], actor: undefined }
    ])
  })

  // A selection change is acked and otherwise ignored: there is no state to record.
  it('acks a selection change without reporting anything', async () => {
    const seen: unknown[] = []
    const actions = await connect({ onElicitConfirm: (a: unknown) => seen.push(a) })
    const select = [...actions.entries()].find(([id]) => id.includes(`${ELICIT_SELECT_ACTION}:`))![1]
    let acked = false
    await select({
      ack: async () => void (acked = true),
      action: { action_id: `${ELICIT_SELECT_ACTION}:elicit-9`, selected_options: [{ value: 'lint' }] },
      body: {}
    })
    expect(acked).toBe(true)
    expect(seen).toEqual([])
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
