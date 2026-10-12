/**
 * A runtime-settings change the agent does not take from chat is refused privately: only the
 * person who made it is told who can change it and where, and nothing changes for anyone else.
 */
import { describe, it, expect, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { DiscordConnection } from '../src/discord/connection.js'
import { buildDiscordSelectComponents } from '../src/discord/render.js'

const AGENT = 'agent-1'
const KEY = 'slack:C1:1700000000.000100:agent-1'
const SESSION = {
  key: KEY,
  agentId: AGENT,
  platform: 'slack',
  channel: 'C1',
  thread: '1700000000.000100',
  acpSessionId: null
}

/** An unstarted daemon serving one agent at `level`, with one stored session. */
function daemonAt(level: 'talk' | 'approve' | 'settings') {
  const daemon = new Daemon({ sandboxMechanism: null } as never) as any
  daemon.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  daemon.agentLink = (id: string) => `https://console.example.test/agents/${id}`
  daemon.agents.set(AGENT, {
    id: AGENT,
    chatActions: level,
    integrations: [{ id: 'int-a', platform: 'slack', core: { mode: 'shared' } }]
  })
  const store = {
    getSession: vi.fn(async (key: string) => (key === KEY ? SESSION : undefined)),
    setModelOverride: vi.fn(async () => {}),
    setFastModeOverride: vi.fn(async () => {}),
    setOutputModeOverride: vi.fn(async () => {})
  }
  daemon.store = store
  return { daemon, store }
}

describe('a refused runtime-settings change is told only to whoever made it', () => {
  it('returns who can change it and where, in the session’s conversation, and changes nothing', async () => {
    const { daemon, store } = daemonAt('approve')
    const refusal = await daemon.commands.handleStatusAction({
      kind: 'set-model',
      sessionKey: KEY,
      model: 'opus',
      actor: { userId: 'U-BOB' }
    })
    expect(refusal).toEqual({
      text: 'Only an Agent editor can change runtime settings. They can change them in the console: https://console.example.test/agents/agent-1',
      channel: 'C1',
      thread: '1700000000.000100'
    })
    expect(store.setModelOverride).not.toHaveBeenCalled()
    // Output verbosity is not a runtime setting, so it is never refused this way.
    await expect(
      daemon.commands.handleStatusAction({ kind: 'set-output', sessionKey: KEY, outputMode: 'low' })
    ).resolves.toBeUndefined()
  })

  it('answers a relayed Slack change privately to the member who made it', async () => {
    const { daemon } = daemonAt('approve')
    const conn = { postEphemeral: vi.fn(async () => true) }
    daemon.connByIntegration = new Map([['int-a', conn]])
    const ack = await daemon.handleRelaySlackAction({
      agentId: AGENT,
      sessionKey: KEY,
      msgId: 'm-1',
      botId: 'shared-bot',
      integrationId: 'int-a',
      userId: 'U-BOB',
      payload: { kind: 'set-fast', fastMode: true }
    })
    expect(ack).toEqual({ msgId: 'm-1', accepted: true })
    expect(conn.postEphemeral).toHaveBeenCalledWith(
      'C1',
      'U-BOB',
      expect.stringContaining('Only an Agent editor can change runtime settings.'),
      '1700000000.000100'
    )
  })
})

describe('a Discord select card keeps the value really in force', () => {
  it('leaves the card alone and returns a notice for its tapper when chat changes are off', async () => {
    const { daemon } = daemonAt('approve')
    daemon.statusInfoFrom = async () => ({ model: 'opus', models: ['opus', 'sonnet'] })
    await expect(daemon.commands.handleDiscordSelect({ kind: 'model', index: 1, sessionKey: KEY })).resolves.toEqual({
      notice: expect.stringContaining('/agents/agent-1')
    })
  })

  it('redraws the current value, not the refused one, when a change does not apply', async () => {
    const { daemon, store } = daemonAt('settings')
    daemon.statusInfoFrom = async () => ({ model: 'opus', models: ['opus', 'sonnet'] })
    // A model on another provider cannot be switched to on the shared credential host.
    daemon.modelSessions = { crossesHostProvider: () => true, has: () => false }
    const card = await daemon.commands.handleDiscordSelect({ kind: 'model', index: 1, sessionKey: KEY })
    expect(store.setModelOverride).not.toHaveBeenCalled()
    expect(card).toEqual({
      text: expect.stringContaining('current: opus'),
      components: buildDiscordSelectComponents('model', 'opus', ['opus', 'sonnet'])
    })
  })

  it('tells only the tapper, ephemerally, and leaves the message as it is', async () => {
    const notice = 'Only an Agent editor can change runtime settings.'
    const connection = new DiscordConnection({
      group: { botToken: 'token', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 'trace',
      onSelectAction: async () => ({ notice })
    }) as any
    connection.statusKeys.set('CH1:M1', KEY)
    const updateMessage = vi.spyOn(connection, 'updateMessage').mockResolvedValue(undefined)
    const components = buildDiscordSelectComponents('model', 'opus', ['opus', 'sonnet'])!
    const interaction = {
      customId: (components[0] as any).components[1].custom_id,
      channelId: 'CH1',
      message: { id: 'M1' },
      user: { id: 'U-BOB', bot: false },
      deferUpdate: vi.fn(async () => {}),
      followUp: vi.fn(async () => {})
    }
    await connection.onStatusButton(interaction)
    expect(interaction.followUp).toHaveBeenCalledWith({ content: notice, flags: 64 })
    expect(updateMessage).not.toHaveBeenCalled()
  })
})
