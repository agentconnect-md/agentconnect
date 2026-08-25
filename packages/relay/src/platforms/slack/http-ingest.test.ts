import { describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  ELICIT_ACTION_PREFIX,
  ELICIT_DISMISS_ACTION,
  PERMISSION_ACTION_PREFIX,
  SHARED_AGENT_SELECT_ACTION_ID,
  SHARED_CONFIG_ACTION_ID,
  SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID,
  SLACK_STATUS_ACTION,
  encodeSlackStatusOverflowValue,
  encodeSharedSlackStatusTarget
} from '@agentconnect.md/protocol'
import { SLACK_RESPONSE_FINAL_EVENT_TAG } from '@agentconnect.md/message'
import {
  normalizeSlackMessage,
  parseHttpSlackAgentSelection,
  parseHttpSlackAgentSwitch,
  parseHttpSlackSessionAction,
  httpSlackAgentOptions,
  SlackHttpIngest,
  type SlackHttpIngestDeps,
  type SlackInteractiveBody
} from './http-ingest.js'
import { verifySlackSignature } from '../../hooks/signature.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222'
const SESSION_KEY = 'slack:C123:1720000000.000100:agent'
const TARGET = { v: 1 as const, agentId: AGENT_ID, integrationId: INTEGRATION_ID, sessionKey: SESSION_KEY }
const ENCODED_TARGET = encodeSharedSlackStatusTarget(TARGET)

function body(actionId: string, over: Partial<SlackInteractiveBody> = {}): SlackInteractiveBody {
  return {
    type: 'block_actions',
    trigger_id: 'trigger-1',
    actions: [{ action_id: actionId, action_ts: '1720000000.000200' }],
    view: { private_metadata: ENCODED_TARGET },
    ...over
  }
}

describe('parseHttpSlackSessionAction', () => {
  it('parses the status gear from action.value and keeps a stable interaction receipt', () => {
    const parsed = parseHttpSlackSessionAction(
      body(SLACK_STATUS_ACTION.manage, {
        actions: [
          {
            action_id: SLACK_STATUS_ACTION.manage,
            action_ts: '1720000000.000200',
            value: ENCODED_TARGET
          }
        ]
      })
    )
    expect(parsed).toEqual({
      target: TARGET,
      interactionId: JSON.stringify([SLACK_STATUS_ACTION.manage, '1720000000.000200']),
      kind: 'open-config',
      triggerId: 'trigger-1'
    })
  })

  it('carries the tapping user through, and leaves it absent when the payload has none', () => {
    const withUser = parseHttpSlackSessionAction(
      body(SLACK_STATUS_ACTION.setModel, {
        user: { id: 'U-ALICE' },
        actions: [
          {
            action_id: SLACK_STATUS_ACTION.setModel,
            action_ts: '1720000000.000200',
            selected_option: { value: 'opus' }
          }
        ]
      })
    )
    expect(withUser).toMatchObject({ kind: 'set-model', model: 'opus', userId: 'U-ALICE' })

    // A payload without `user` yields no key at all — never an empty or invented id.
    const withoutUser = parseHttpSlackSessionAction(
      body(SLACK_STATUS_ACTION.setModel, {
        actions: [
          {
            action_id: SLACK_STATUS_ACTION.setModel,
            action_ts: '1720000000.000200',
            selected_option: { value: 'opus' }
          }
        ]
      })
    )
    expect(withoutUser).toMatchObject({ kind: 'set-model', model: 'opus' })
    expect(withoutUser).not.toHaveProperty('userId')
  })

  it('parses Session options and Cancel from the compact overflow', () => {
    const manage = parseHttpSlackSessionAction(
      body(SLACK_STATUS_ACTION.more, {
        actions: [
          {
            action_id: SLACK_STATUS_ACTION.more,
            action_ts: '1720000000.000250',
            block_id: ENCODED_TARGET,
            selected_option: { value: encodeSlackStatusOverflowValue('manage') }
          }
        ]
      })
    )
    expect(manage).toMatchObject({ target: TARGET, kind: 'open-config', triggerId: 'trigger-1' })

    const cancel = parseHttpSlackSessionAction(
      body(SLACK_STATUS_ACTION.more, {
        actions: [
          {
            action_id: SLACK_STATUS_ACTION.more,
            action_ts: '1720000000.000251',
            block_id: ENCODED_TARGET,
            selected_option: { value: encodeSlackStatusOverflowValue('cancel') }
          }
        ]
      })
    )
    expect(cancel).toMatchObject({ target: TARGET, kind: 'cancel' })

    const legacyCancel = parseHttpSlackSessionAction(
      body(SLACK_STATUS_ACTION.more, {
        actions: [
          {
            action_id: SLACK_STATUS_ACTION.more,
            action_ts: '1720000000.000252',
            selected_option: {
              value: JSON.stringify({ v: 1, action: 'cancel', target: ENCODED_TARGET })
            }
          }
        ]
      })
    )
    expect(legacyCancel).toMatchObject({ target: TARGET, kind: 'cancel' })
  })

  it.each([
    [SLACK_STATUS_ACTION.setModel, 'opus-4.8', { kind: 'set-model', model: 'opus-4.8' }],
    [SLACK_STATUS_ACTION.setEffort, 'high', { kind: 'set-effort', effort: 'high' }],
    [SLACK_STATUS_ACTION.setPermissionMode, 'plan', { kind: 'set-permission-mode', permissionMode: 'plan' }],
    [SLACK_STATUS_ACTION.setFast, 'on', { kind: 'set-fast', fastMode: true }],
    [SLACK_STATUS_ACTION.setOutput, 'medium', { kind: 'set-output', outputMode: 'medium' }]
  ])('parses modal action %s from private_metadata', (actionId, selected, expected) => {
    const parsed = parseHttpSlackSessionAction(
      body(actionId, {
        actions: [{ action_id: actionId, action_ts: '1720000000.000300', selected_option: { value: selected } }]
      })
    )
    expect(parsed).toMatchObject({
      target: TARGET,
      interactionId: JSON.stringify([actionId, '1720000000.000300']),
      ...expected
    })
  })

  it('parses cancel and falls back to trigger_id when action_ts is absent', () => {
    expect(
      parseHttpSlackSessionAction(
        body(SLACK_STATUS_ACTION.cancel, { actions: [{ action_id: SLACK_STATUS_ACTION.cancel }] })
      )
    ).toEqual({
      target: TARGET,
      interactionId: JSON.stringify([SLACK_STATUS_ACTION.cancel, 'trigger-1']),
      kind: 'cancel'
    })
  })

  it('routes permission and elicitation message buttons from their relay block target', () => {
    const parseCard = (action_id: string, value: string) =>
      parseHttpSlackSessionAction(
        body(action_id, {
          actions: [{ action_id, action_ts: '1720000000.000500', block_id: ENCODED_TARGET, value }],
          view: undefined
        })
      )

    expect(parseCard(`${PERMISSION_ACTION_PREFIX}:0`, 'perm-1|allow_once')).toMatchObject({
      target: TARGET,
      kind: 'permission-choice',
      requestId: 'perm-1',
      optionId: 'allow_once'
    })
    expect(parseCard(`${ELICIT_ACTION_PREFIX}:1`, 'elicit-1|TypeScript')).toMatchObject({
      target: TARGET,
      kind: 'elicitation-choice',
      requestId: 'elicit-1',
      value: 'TypeScript'
    })
    expect(parseCard(ELICIT_DISMISS_ACTION, 'elicit-2')).toMatchObject({
      target: TARGET,
      kind: 'elicitation-choice',
      requestId: 'elicit-2',
      value: null
    })
    expect(
      parseHttpSlackSessionAction(
        body(`${PERMISSION_ACTION_PREFIX}:0`, {
          actions: [{ action_id: `${PERMISSION_ACTION_PREFIX}:0`, action_ts: '1', value: 'perm-1|allow_once' }]
        })
      )
    ).toBeNull()
  })

  it('parses an inline Cancel target from action.value', () => {
    expect(
      parseHttpSlackSessionAction({
        type: 'block_actions',
        actions: [{ action_id: SLACK_STATUS_ACTION.cancel, action_ts: '1', value: ENCODED_TARGET }]
      })
    ).toMatchObject({ target: TARGET, kind: 'cancel' })
  })

  it('never turns the relay-local person/default-agent control into a daemon action', () => {
    expect(
      parseHttpSlackSessionAction(
        body(SHARED_CONFIG_ACTION_ID, {
          actions: [{ action_id: SHARED_CONFIG_ACTION_ID, action_ts: '1720000000.000400', value: ENCODED_TARGET }]
        })
      )
    ).toBeNull()
  })

  it('rejects malformed/tampered targets, unknown values, and receipts with no stable id', () => {
    expect(
      parseHttpSlackSessionAction(
        body(SLACK_STATUS_ACTION.manage, {
          actions: [{ action_id: SLACK_STATUS_ACTION.manage, action_ts: '1', value: '{bad-json' }]
        })
      )
    ).toBeNull()
    const extraField = JSON.stringify({ ...TARGET, daemonId: 'attacker-chosen-daemon' })
    expect(
      parseHttpSlackSessionAction(
        body(SLACK_STATUS_ACTION.manage, {
          actions: [{ action_id: SLACK_STATUS_ACTION.manage, action_ts: '1', value: extraField }]
        })
      )
    ).toBeNull()
    expect(
      parseHttpSlackSessionAction(
        body(SLACK_STATUS_ACTION.setFast, {
          actions: [{ action_id: SLACK_STATUS_ACTION.setFast, action_ts: '1', selected_option: { value: 'maybe' } }]
        })
      )
    ).toBeNull()
    expect(
      parseHttpSlackSessionAction({
        type: 'block_actions',
        actions: [{ action_id: SLACK_STATUS_ACTION.cancel }],
        view: { private_metadata: ENCODED_TARGET }
      })
    ).toBeNull()
  })
})

describe('HTTP Slack agent selector', () => {
  const agents = [
    { agentId: AGENT_ID, name: 'Deploy Agent' },
    { agentId: '33333333-3333-4333-8333-333333333333', name: 'Review Agent' }
  ]

  it('serves matching options and accepts only a current HTTP-bot member', () => {
    expect(httpSlackAgentOptions(agents, 'deploy')).toEqual([
      { text: { type: 'plain_text', text: 'Deploy Agent' }, value: AGENT_ID }
    ])
    expect(
      parseHttpSlackAgentSelection(
        {
          type: 'block_actions',
          channel: { id: 'C123' },
          message: { ts: '1720000000.000200', thread_ts: '1720000000.000100' },
          actions: [{ action_id: SHARED_AGENT_SELECT_ACTION_ID, selected_option: { value: AGENT_ID } }]
        },
        agents
      )
    ).toEqual({ channelId: 'C123', threadTs: '1720000000.000100', agentId: AGENT_ID })
  })

  it('opens Switch agent for the current thread without treating it as a daemon action', () => {
    const interaction = body(SLACK_STATUS_ACTION.more, {
      channel: { id: 'C123' },
      message: { ts: '1720000000.000200', thread_ts: '1720000000.000100' },
      actions: [
        {
          action_id: SLACK_STATUS_ACTION.more,
          action_ts: '1720000000.000200',
          block_id: ENCODED_TARGET,
          selected_option: { value: encodeSlackStatusOverflowValue('switch-agent') }
        }
      ]
    })
    expect(parseHttpSlackAgentSwitch(interaction)).toEqual({
      channelId: 'C123',
      threadTs: '1720000000.000100',
      currentAgentId: AGENT_ID
    })
    expect(parseHttpSlackSessionAction(interaction)).toBeNull()

    const legacyInteraction = {
      ...interaction,
      actions: [
        {
          action_id: SLACK_STATUS_ACTION.more,
          action_ts: '1720000000.000201',
          selected_option: {
            value: JSON.stringify({ v: 1, action: 'switch-agent', target: ENCODED_TARGET })
          }
        }
      ]
    }
    expect(parseHttpSlackAgentSwitch(legacyInteraction)).toEqual({
      channelId: 'C123',
      threadTs: '1720000000.000100',
      currentAgentId: AGENT_ID
    })
  })
})

describe('SlackHttpIngest.handleInteraction', () => {
  const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  const ingestDeps = (over: Partial<SlackHttpIngestDeps> = {}): SlackHttpIngestDeps => ({
    onMessage: vi.fn(async () => {}),
    onBotUserId: vi.fn(),
    onChannelsChanged: vi.fn(),
    agents: () => [
      { agentId: AGENT_ID, name: 'Deploy Agent' },
      { agentId: '33333333-3333-4333-8333-333333333333', name: 'Review Agent' }
    ],
    currentOwner: () => undefined,
    onSetChannelAgent: vi.fn(),
    onSelectThreadAgent: vi.fn(),
    onSessionAction: vi.fn(),
    onSessionShortcut: vi.fn(() => false),
    onSessionStopped: vi.fn(),
    log: silentLog,
    ...over
  })

  it('returns the external-select options on the 200 body for a block_suggestion', async () => {
    const ingest = new SlackHttpIngest('bot', { botToken: 'xoxb', signingSecret: 's' }, ingestDeps())
    const result = await ingest.handleInteraction({
      type: 'block_suggestion',
      action_id: SHARED_AGENT_SELECT_ACTION_ID,
      value: 'deploy'
    })
    expect(result).toEqual({ options: [{ text: { type: 'plain_text', text: 'Deploy Agent' }, value: AGENT_ID }] })
  })

  it('fires the thread-agent selection and returns an empty 200 body', async () => {
    const onSelectThreadAgent = vi.fn()
    const ingest = new SlackHttpIngest(
      'bot',
      { botToken: 'xoxb', signingSecret: 's' },
      ingestDeps({ onSelectThreadAgent })
    )
    const result = await ingest.handleInteraction({
      type: 'block_actions',
      channel: { id: 'C123' },
      message: { ts: '1720000000.000200', thread_ts: '1720000000.000100' },
      actions: [{ action_id: SHARED_AGENT_SELECT_ACTION_ID, selected_option: { value: AGENT_ID } }]
    })
    expect(result).toBe('')
    expect(onSelectThreadAgent).toHaveBeenCalledWith('C123', '1720000000.000100', AGENT_ID)
  })

  it('forwards a message shortcut with the selected conversation coordinates', async () => {
    const onSessionShortcut = vi.fn(() => true)
    const ingest = new SlackHttpIngest(
      'bot',
      { botToken: 'xoxb', signingSecret: 's' },
      ingestDeps({ onSessionShortcut })
    )
    const result = await ingest.handleInteraction({
      type: 'message_action',
      callback_id: SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID,
      trigger_id: 'trigger-shortcut',
      channel: { id: 'C123' },
      message: { ts: '1720000000.000200', thread_ts: '1720000000.000100' },
      user: { id: 'U-ALICE' }
    })

    expect(result).toBe('')
    expect(onSessionShortcut).toHaveBeenCalledWith({
      triggerId: 'trigger-shortcut',
      channelId: 'C123',
      threadTs: '1720000000.000100',
      interactionId: 'trigger-shortcut',
      userId: 'U-ALICE'
    })
  })
})

describe('SlackHttpIngest channel membership events', () => {
  const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  const deps = (web: object, over: Partial<SlackHttpIngestDeps> = {}): SlackHttpIngestDeps => ({
    onMessage: vi.fn(async () => {}),
    onBotUserId: vi.fn(),
    onChannelsChanged: vi.fn(),
    agents: () => [],
    currentOwner: () => undefined,
    onSetChannelAgent: vi.fn(),
    onSelectThreadAgent: vi.fn(),
    onSessionAction: vi.fn(),
    onSessionShortcut: vi.fn(() => false),
    onSessionStopped: vi.fn(),
    webClientFactory: () => web as never,
    log: silentLog,
    ...over
  })

  it('refreshes the complete paginated snapshot only when the bot itself joins', async () => {
    const conversations = vi.fn(async ({ cursor }: { cursor?: string }) =>
      cursor
        ? { channels: [{ id: 'C3' }], response_metadata: {} }
        : {
            channels: [
              { id: 'C1', name: 'deploys' },
              { id: 'D1', is_im: true },
              { id: 'C2', name: 'ops', is_private: true }
            ],
            response_metadata: { next_cursor: 'page-2' }
          }
    )
    const web = { auth: { test: vi.fn(async () => ({ user_id: 'UBOT' })) }, users: { conversations } }
    const onChannelsChanged = vi.fn()
    const ingest = new SlackHttpIngest(
      'bot',
      { botToken: 'xoxb', signingSecret: 's' },
      deps(web, { onChannelsChanged })
    )
    await ingest.start()

    await ingest.handleEvent({ type: 'member_joined_channel', user: 'UOTHER', channel: 'C1' })
    expect(conversations).not.toHaveBeenCalled()

    await ingest.handleEvent({ type: 'member_joined_channel', user: 'UBOT', channel: 'C1' })
    expect(conversations).toHaveBeenCalledTimes(2)
    expect(onChannelsChanged).toHaveBeenCalledWith([
      { id: 'C1', name: 'deploys' },
      { id: 'C2', name: 'ops', isPrivate: true },
      { id: 'C3' }
    ])
  })

  it.each(['channel_left', 'group_left'])('refreshes after the self-scoped %s event', async (type) => {
    const conversations = vi.fn(async () => ({ channels: [{ id: 'C1', name: 'remaining' }] }))
    const web = { auth: { test: vi.fn(async () => ({ user_id: 'UBOT' })) }, users: { conversations } }
    const onChannelsChanged = vi.fn()
    const ingest = new SlackHttpIngest(
      'bot',
      { botToken: 'xoxb', signingSecret: 's' },
      deps(web, { onChannelsChanged })
    )
    await ingest.start()

    await ingest.handleEvent({ type, channel: 'CLEFT' })

    expect(onChannelsChanged).toHaveBeenCalledWith([{ id: 'C1', name: 'remaining' }])
  })

  // The native Stop. Also not a chat event, and the event id is the receipt a Slack
  // redelivery reuses, so the daemon-side dedup id it mints is stable.
  it('forwards the agent-session stop with its conversation and the tapping user', async () => {
    const web = { auth: { test: vi.fn(async () => ({ user_id: 'UBOT' })) } }
    const onSessionStopped = vi.fn()
    const onMessage = vi.fn(async () => {})
    const ingest = new SlackHttpIngest(
      'bot',
      { botToken: 'xoxb', signingSecret: 's' },
      deps(web, { onSessionStopped, onMessage })
    )
    await ingest.start()

    await ingest.handleEvent(
      { type: 'agent_session_stopped', channel: 'C1', thread_ts: '200.1', user: 'U-ALICE' },
      1_700_000_000_000,
      'Ev123'
    )

    expect(onSessionStopped).toHaveBeenCalledWith({
      channelId: 'C1',
      threadTs: '200.1',
      interactionId: 'Ev123',
      userId: 'U-ALICE'
    })
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('omits the actor when the stop names none, and drops one without a thread', async () => {
    const web = { auth: { test: vi.fn(async () => ({ user_id: 'UBOT' })) } }
    const onSessionStopped = vi.fn()
    const ingest = new SlackHttpIngest('bot', { botToken: 'xoxb', signingSecret: 's' }, deps(web, { onSessionStopped }))
    await ingest.start()

    await ingest.handleEvent({ type: 'agent_session_stopped', channel: 'C1', thread_ts: '200.1' }, undefined, 'Ev124')
    await ingest.handleEvent({ type: 'agent_session_stopped', channel: 'C1' }, undefined, 'Ev125')

    expect(onSessionStopped).toHaveBeenCalledTimes(1)
    expect(onSessionStopped.mock.calls[0]![0]).not.toHaveProperty('userId')
  })

  // Subscribed so a future feature needs no manifest-refresh cycle, but nothing acts on them:
  // they fall through to the same drop every unrecognized event takes.
  it.each(['agent_session_title_changed', 'assistant_thread_context_changed'] as const)(
    'drops the inert %s subscription',
    async (type) => {
      const web = { auth: { test: vi.fn(async () => ({ user_id: 'UBOT' })) } }
      const onSessionStopped = vi.fn()
      const onMessage = vi.fn(async () => {})
      const ingest = new SlackHttpIngest(
        'bot',
        { botToken: 'xoxb', signingSecret: 's' },
        deps(web, { onSessionStopped, onMessage })
      )
      await ingest.start()

      await ingest.handleEvent({ type, channel: 'C1', thread_ts: '200.1', user: 'U-ALICE' })

      expect(onSessionStopped).not.toHaveBeenCalled()
      expect(onMessage).not.toHaveBeenCalled()
    }
  )

  // App lifecycle (preset-agents.md §5.3): the workspace pulled the app / revoked
  // its tokens. Not a chat event — it has no user/bot_id, so without the explicit
  // branch the routable-event filters would silently drop it.
  it.each(['app_uninstalled', 'tokens_revoked'] as const)('reports %s upstream as a bot revocation', async (type) => {
    const web = { auth: { test: vi.fn(async () => ({ user_id: 'UBOT' })) } }
    const onBotRevoked = vi.fn()
    const onMessage = vi.fn(async () => {})
    const ingest = new SlackHttpIngest(
      'bot',
      { botToken: 'xoxb', signingSecret: 's' },
      deps(web, { onBotRevoked, onMessage })
    )
    await ingest.start()

    // The envelope's `event_time` rides along (already ms here): the CP fences a
    // revocation that predates the credential it would kill.
    await ingest.handleEvent({ type }, 1_700_000_000_000)

    expect(onBotRevoked).toHaveBeenCalledWith(type, 1_700_000_000_000)
    expect(onMessage).not.toHaveBeenCalled()
  })

  // The backstop the in-memory retry queue cannot be: if the `app_uninstalled`
  // event itself was lost (Slack acked it before the handler ran and never
  // redelivers), the next assign / pod restart still probes auth.test and finds
  // the credential dead.
  it.each(['account_inactive', 'token_revoked', 'invalid_auth'])(
    'reports a revocation when auth.test says the credential is dead (%s)',
    async (code) => {
      const web = {
        auth: { test: vi.fn(async () => Promise.reject(Object.assign(new Error(code), { data: { error: code } }))) }
      }
      const onBotRevoked = vi.fn()
      const ingest = new SlackHttpIngest('bot', { botToken: 'xoxb', signingSecret: 's' }, deps(web, { onBotRevoked }))

      await ingest.start()

      // No occurrence time: we don't know WHEN the workspace pulled the app. The
      // revision arm is the right fence anyway — it names the credential just
      // probed.
      expect(onBotRevoked).toHaveBeenCalledWith('tokens_revoked')
    }
  )

  // A false positive here would revoke a LIVE bot, so the match must stay narrow.
  it.each(['ratelimited', 'missing_scope', 'internal_error'])(
    'does NOT report a revocation for the transient auth.test failure %s',
    async (code) => {
      const web = {
        auth: { test: vi.fn(async () => Promise.reject(Object.assign(new Error(code), { data: { error: code } }))) }
      }
      const onBotRevoked = vi.fn()
      const ingest = new SlackHttpIngest('bot', { botToken: 'xoxb', signingSecret: 's' }, deps(web, { onBotRevoked }))

      await ingest.start()

      expect(onBotRevoked).not.toHaveBeenCalled()
    }
  )

  it('does NOT report a revocation for a network error with no Slack error code', async () => {
    const web = { auth: { test: vi.fn(async () => Promise.reject(new Error('ECONNRESET'))) } }
    const onBotRevoked = vi.fn()
    const ingest = new SlackHttpIngest('bot', { botToken: 'xoxb', signingSecret: 's' }, deps(web, { onBotRevoked }))

    await ingest.start()

    expect(onBotRevoked).not.toHaveBeenCalled()
  })

  it('reports a revocation with no occurrence time when the envelope omitted event_time', async () => {
    const web = { auth: { test: vi.fn(async () => ({ user_id: 'UBOT' })) } }
    const onBotRevoked = vi.fn()
    const ingest = new SlackHttpIngest('bot', { botToken: 'xoxb', signingSecret: 's' }, deps(web, { onBotRevoked }))
    await ingest.start()

    await ingest.handleEvent({ type: 'app_uninstalled' })

    // Fail-open at the CP (an uninstall must eventually take effect), so the
    // relay reports it rather than withholding an unfenced revocation.
    expect(onBotRevoked).toHaveBeenCalledWith('app_uninstalled', undefined)
  })
})

// Mirrors the daemon's slack/normalize.ts: a group DM is classified but never
// treated as addressed, so it stays mention-gated like a channel.
describe('normalizeSlackMessage conversation kinds', () => {
  const event = (channel: string, channelType?: string) => ({
    type: 'message',
    channel,
    ...(channelType ? { channel_type: channelType } : {}),
    ts: '1.1',
    user: 'U1',
    text: 'hi <@BOTA>'
  })

  it('flags a group DM without marking it a DM', () => {
    const m = normalizeSlackMessage(event('G1', 'mpim'))
    expect(m).toMatchObject({ isDm: false, isGroupDm: true })
  })

  it('marks a DM and leaves the group-DM flag unset', () => {
    expect(normalizeSlackMessage(event('D1', 'im'))).toMatchObject({ isDm: true })
    expect(normalizeSlackMessage(event('D1', 'im'))?.isGroupDm).toBeUndefined()
  })

  it('leaves both unset when the payload omits channel_type (app_mention)', () => {
    const m = normalizeSlackMessage(event('G1'))
    expect(m?.isDm).toBe(false)
    expect(m?.isGroupDm).toBeUndefined()
  })
})

describe('SlackHttpIngest message events', () => {
  const ingestFor = (onMessage: SlackHttpIngestDeps['onMessage'], botId = 'BSELF') =>
    new SlackHttpIngest(
      'bot',
      { botToken: 'xoxb', signingSecret: 's' },
      {
        onMessage,
        onBotUserId: vi.fn(),
        onChannelsChanged: vi.fn(),
        agents: () => [],
        currentOwner: () => undefined,
        onSetChannelAgent: vi.fn(),
        onSelectThreadAgent: vi.fn(),
        onSessionAction: vi.fn(),
        onSessionShortcut: vi.fn(() => false),
        onSessionStopped: vi.fn(),
        webClientFactory: () => ({ auth: { test: vi.fn(async () => ({ user_id: 'UBOT', bot_id: botId })) } }) as never,
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
      }
    )

  // slack-streaming-turn-output.md §3.3/§7.1: a native streamed turn closes its response on
  // `chat.stopStream`, which emits no `message_changed` edit — the finalized message arrives as
  // an ordinary bot message carrying the SAME `final` metadata the legacy closing edit carried.
  // A2A on shareable bots (all relay-inbound) depends on ingress recognising THAT, before the
  // own-echo filter that would otherwise drop the bot's own post.
  const finalMetadata = (deliveryState: 'streaming' | 'final') => ({
    metadata: {
      event_type: 'agentconnect_thread_event',
      event_payload: {
        author_agent_id: 'agent-author',
        response_id: 'r-1',
        delivery_state: deliveryState,
        hop_count: 2,
        mentioned_agent_ids: ['agent-peer']
      }
    }
  })

  it('forwards a stop-time finalization on the bot own message, past the own-echo filter', async () => {
    const onMessage = vi.fn<SlackHttpIngestDeps['onMessage']>(async () => {})
    const ingest = ingestFor(onMessage)
    await ingest.start()

    // The bot's OWN post (bot_id === the resolved self id) still forwards, because it closes a
    // logical response — echo suppression alone would make shared-bot A2A impossible.
    await ingest.handleEvent({
      type: 'message',
      channel: 'C1',
      ts: '900.1',
      thread_ts: '900.0',
      bot_id: 'BSELF',
      app_id: 'AMANAGED',
      text: '<@UPEER> please verify the rollout',
      ...finalMetadata('final')
    })

    expect(onMessage).toHaveBeenCalledTimes(1)
    const [message] = onMessage.mock.calls[0]!
    expect(message.ingressEventTag).toBe(SLACK_RESPONSE_FINAL_EVENT_TAG)
    expect(message.agentAuthorship?.authorAgentId).toBe('agent-author')
    expect(message.agentAuthorship?.mentionedAgentIds).toEqual(['agent-peer'])
    expect(message.msgId).toBe('slack:C1:900.1')
  })

  it('does not forward a mid-stream append (streaming metadata) as a finalization', async () => {
    const onMessage = vi.fn<SlackHttpIngestDeps['onMessage']>(async () => {})
    const ingest = ingestFor(onMessage)
    await ingest.start()

    await ingest.handleEvent({
      type: 'message',
      channel: 'C1',
      ts: '900.1',
      thread_ts: '900.0',
      bot_id: 'BSELF',
      app_id: 'AMANAGED',
      text: 'partial answer so far',
      ...finalMetadata('streaming')
    })

    // A `streaming` post is dropped by the own-echo filter exactly as before — only the stop routes.
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('drops self and Slack system messages while forwarding peer app text', async () => {
    const onMessage = vi.fn<SlackHttpIngestDeps['onMessage']>(async () => {})
    const botIds = [undefined, 'BSELF']
    const web = { auth: { test: vi.fn(async () => ({ user_id: 'UBOT', bot_id: botIds.shift() })) } }
    const ingest = new SlackHttpIngest(
      'bot',
      { botToken: 'xoxb', signingSecret: 's' },
      {
        onMessage,
        onBotUserId: vi.fn(),
        onChannelsChanged: vi.fn(),
        agents: () => [],
        currentOwner: () => undefined,
        onSetChannelAgent: vi.fn(),
        onSelectThreadAgent: vi.fn(),
        onSessionAction: vi.fn(),
        onSessionShortcut: vi.fn(() => false),
        onSessionStopped: vi.fn(),
        webClientFactory: () => web as never,
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
      }
    )
    await ingest.start()

    const botEvent = { type: 'message', subtype: 'bot_message', channel: 'C1' }
    await ingest.handleEvent({
      type: 'message',
      channel: 'D1',
      channel_type: 'im',
      ts: '99.7',
      user: 'USLACK',
      text: '<@U1> added you to <#C1>.'
    })
    await ingest.handleEvent({ ...botEvent, ts: '99.8', bot_id: 'BPEER', text: 'identity unresolved' })
    await ingest.handleEvent({ type: 'app_mention', channel: 'C1', ts: '99.9', user: 'U1', text: '<@UBOT> hi' })
    await ingest.start()
    await ingest.handleEvent({ ...botEvent, ts: '100.0', bot_id: 'BSELF', text: 'self echo' })
    await ingest.handleEvent({
      ...botEvent,
      ts: '100.1',
      bot_id: 'BCHANGELOGUE',
      bot_profile: { app_id: 'ACHANGELOGUE' },
      text: '<@UBOT>',
      attachments: [
        {
          author_name: 'paradigmxyz/reth on GitHub',
          author_link: 'https://example.test/reth',
          title: 'reth v2.4.0',
          title_link: 'https://example.test/reth/releases/v2.4.0',
          text: 'Performance improvements',
          footer: 'Added by changelogue',
          actions: [
            { type: 'button', text: 'Acknowledge' },
            { type: 'button', text: 'Resolve' }
          ]
        }
      ]
    })

    expect(onMessage).toHaveBeenCalledTimes(2)
    const [message] = onMessage.mock.calls[1]!
    expect(message.text).toContain('<@UBOT>')
    expect(message.text).toContain('<https://example.test/reth|paradigmxyz/reth on GitHub>')
    expect(message.text).toContain('Performance improvements')
    expect(message.text).not.toContain('Acknowledge')
    expect(message.sender).toEqual({ id: 'BCHANGELOGUE', isBot: true, appId: 'ACHANGELOGUE' })
  })
})

describe('verifySlackSignature', () => {
  const secret = 'slack-signing-secret'
  const now = 1_720_000_000_000
  const ts = String(Math.floor(now / 1000))
  const sign = (rawBody: string, tstamp = ts, sec = secret) =>
    `v0=${createHmac('sha256', sec).update(`v0:${tstamp}:${rawBody}`).digest('hex')}`

  it('accepts a correct v0 signature over `v0:${timestamp}:${rawBody}`', () => {
    const raw = Buffer.from(JSON.stringify({ type: 'event_callback', event_id: 'Ev1' }))
    expect(verifySlackSignature(secret, ts, raw, sign(raw.toString('utf8')), now)).toBe(true)
  })

  it('rejects a wrong secret, a malformed header, a stale timestamp, and a missing timestamp', () => {
    const raw = Buffer.from('payload=x')
    expect(verifySlackSignature(secret, ts, raw, sign(raw.toString('utf8'), ts, 'other'), now)).toBe(false)
    expect(verifySlackSignature(secret, ts, raw, 'nope', now)).toBe(false)
    // 6 minutes of skew is outside the 5-minute replay window.
    expect(verifySlackSignature(secret, ts, raw, sign(raw.toString('utf8')), now + 6 * 60 * 1000)).toBe(false)
    expect(verifySlackSignature(secret, undefined, raw, sign(raw.toString('utf8')), now)).toBe(false)
  })
})
