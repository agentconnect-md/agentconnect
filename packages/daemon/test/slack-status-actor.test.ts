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
  ELICIT_FORM_CALLBACK_ID,
  ELICIT_OPEN_ACTION,
  ELICIT_SELECT_ACTION,
  PERMISSION_ACTION_PREFIX,
  elicitFormBlockId,
  encodePermValue
} from '../src/slack/render.js'
import { encodeElicitFormMetadata } from '@agentconnect.md/protocol'

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
    state?: { values?: Record<string, Record<string, { selected_options?: { value?: unknown }[] }>> }
  }
}
type Handler = (args: ActionArgs) => Promise<void> | void

type ViewArgs = {
  ack: (response?: unknown) => Promise<void>
  body?: { user?: { id?: string } }
  view?: { private_metadata?: string; state?: { values?: Record<string, Record<string, unknown>> } }
}
type ViewHandler = (args: ViewArgs) => Promise<void> | void

/** A Bolt stand-in: enough surface for `start()` to reach handler registration. */
function fakeApp(actions: Map<string, Handler>, views?: Map<string, ViewHandler>) {
  return {
    init: async () => {},
    message: () => {},
    event: () => {},
    action: (id: string | RegExp, handler: Handler) => actions.set(String(id), handler),
    shortcut: () => {},
    view: (id: string, handler: ViewHandler) => void views?.set(id, handler),
    start: async () => {},
    stop: async () => {},
    client: { auth: { test: async () => ({ user_id: 'UBOT', bot_id: 'BBOT', url: 'https://x.slack.test/' }) } }
  } as never
}

async function connect(deps: Record<string, unknown>, views?: Map<string, ViewHandler>): Promise<Map<string, Handler>> {
  const actions = new Map<string, Handler>()
  const conn = new SlackConnection(
    {
      group: { appToken: 'xapp-test', botToken: 'xoxb-test', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 't',
      sendIntervalMs: 0,
      ...deps
    } as never,
    () => fakeApp(actions, views)
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

  // A multi-field card's two interactions (#1794's Slack column): Answer, which opens the modal
  // the daemon builds, and the modal's own submission, whose verdict rides that ack. Both carry
  // the tapping user, and Answer carries the connection so the view opens on this bot's token.
  it('reports the reader who tapped Answer, and hands the connection the view opens on', async () => {
    const opened: any[] = []
    const actions = await connect({ onElicitFormOpen: (a: unknown) => opened.push(a) })

    await actions.get(ELICIT_OPEN_ACTION)!({
      ack,
      action: { value: 'elicit-7' },
      body: { trigger_id: 'trig-1', user: { id: 'U-CARA' } }
    })
    // No trigger id is nothing to open — the card stays live and Answer can be tapped again.
    await actions.get(ELICIT_OPEN_ACTION)!({ ack, action: { value: 'elicit-7' }, body: { user: { id: 'U-CARA' } } })

    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ requestId: 'elicit-7', triggerId: 'trig-1', actor: { userId: 'U-CARA' } })
    expect(opened[0].conn).toBeInstanceOf(SlackConnection)
  })

  it('submits the modal’s own state and returns the daemon’s verdict on that ack', async () => {
    const submitted: any[] = []
    const views = new Map<string, ViewHandler>()
    await connect(
      {
        onElicitFormSubmit: async (a: unknown) => {
          submitted.push(a)
          return { response_action: 'errors', errors: { [elicitFormBlockId(0)]: 'nope' } }
        }
      },
      views
    )
    const acked: unknown[] = []
    const submit = (view?: ViewArgs['view']) =>
      views.get(ELICIT_FORM_CALLBACK_ID)!({
        ack: async (response?: unknown) => void acked.push(response),
        body: { user: { id: 'U-DEE' } },
        ...(view ? { view } : {})
      })

    await submit({
      private_metadata: encodeElicitFormMetadata({ requestId: 'elicit-7', target: 'tgt' }),
      state: {
        values: {
          [elicitFormBlockId(0)]: { ac_elicit_input: { selected_option: { value: 'main' } } },
          [elicitFormBlockId(1)]: { ac_elicit_input: { value: 'ship it' } },
          [elicitFormBlockId(2)]: { ac_elicit_input: { selected_options: [{ value: 'lint' }] } },
          // A blank input is OMITTED, which is what an untouched optional field means.
          [elicitFormBlockId(3)]: { ac_elicit_input: { value: null } },
          not_ours: { ac_elicit_input: { value: 'injected' } }
        }
      }
    })
    expect(submitted).toEqual([
      {
        requestId: 'elicit-7',
        fields: {
          [elicitFormBlockId(0)]: 'main',
          [elicitFormBlockId(1)]: 'ship it',
          [elicitFormBlockId(2)]: ['lint']
        },
        actor: { userId: 'U-DEE' }
      }
    ])
    expect(acked).toEqual([{ response_action: 'errors', errors: { [elicitFormBlockId(0)]: 'nope' } }])

    // A submission whose metadata is not ours reaches nothing and is just acked closed.
    await submit({ private_metadata: 'garbage' })
    await submit()
    expect(submitted).toHaveLength(1)
    expect(acked).toEqual([
      { response_action: 'errors', errors: { [elicitFormBlockId(0)]: 'nope' } },
      undefined,
      undefined
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
