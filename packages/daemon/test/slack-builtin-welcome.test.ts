import { describe, expect, it, vi } from 'vitest'
import { AgentSchema, IntegrationSchema } from '../src/agents/agent-schema.js'
import { SlackConnection, type AppLike } from '../src/slack/connection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

function fixture(messages: { text?: string }[] = []) {
  const integration = IntegrationSchema.parse({ id: 'integration-1', platform: 'slack' })
  const agent = AgentSchema.parse({
    id: 'agent-1',
    name: 'Renamed agent',
    builtin: true,
    runtime: 'codex',
    workspace: { mode: 'from-scratch', path: '/home/agent/workspace' },
    integrations: [integration]
  })
  const events = new Map<string, Parameters<AppLike['event']>[1]>()
  const app = fakeSlackAppFactory()({ token: 'xoxb-test', appToken: 'xapp-test' })
  const history = vi.fn(async () => ({ messages }))
  const postMessage = vi.fn(async (body: unknown) => {
    messages.push(body as { text?: string })
    return { ts: '1.0' }
  })
  const apiCall = vi.fn(async () => ({}))
  const onMessage = vi.fn()
  app.event = (type, handler) => {
    events.set(type, handler)
  }
  app.client.conversations.history = history
  app.client.chat.postMessage = postMessage
  app.client.apiCall = apiCall
  const conn: SlackConnection = new SlackConnection(
    {
      group: { appToken: 'xapp-test', botToken: 'xoxb-test', integrations: [] },
      newTraceId: () => 'trace',
      sendIntervalMs: 0,
      onMessage,
      onAppHomeOpened: (channel) => conn.welcomeBuiltin(channel, agent, integration)
    },
    () => app
  )
  return { conn, agent, integration, events, history, postMessage, apiCall, onMessage }
}

describe('built-in Slack welcome', () => {
  it('greets an empty DM once across repeated opens and a restart, without producing a model message', async () => {
    const messages: { text?: string }[] = []
    const h = fixture(messages)
    await h.conn.start()
    const open = () => h.events.get('app_home_opened')!({ event: { channel: 'D1', tab: 'messages' } })
    await Promise.all([open(), open()])
    await open()
    expect(h.postMessage).toHaveBeenCalledTimes(1)
    expect(h.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D1',
        metadata: expect.objectContaining({ event_type: 'agentconnect_chrome' })
      })
    )
    expect(h.apiCall).toHaveBeenCalledWith('assistant.threads.setSuggestedPrompts', {
      channel_id: 'D1',
      prompts: expect.arrayContaining([expect.objectContaining({ title: 'Plan a task' })])
    })
    expect(h.onMessage).not.toHaveBeenCalled()
    await h.conn.stop()
    const restarted = fixture(messages)
    await restarted.conn.welcomeBuiltin('D1', restarted.agent, restarted.integration)
    expect(restarted.postMessage).not.toHaveBeenCalled()
  })

  it('uses the preset marker, and respects paused, muted, and restricted conversations', async () => {
    for (const change of ['custom', 'paused', 'muted', 'restricted'] as const) {
      const h = fixture()
      if (change === 'custom') {
        h.agent.builtin = false
        h.agent.name = 'agentconnect'
      }
      if (change === 'paused') h.agent.pause = true
      if (change === 'muted') h.integration.core.mutedChannels = ['D1']
      if (change === 'restricted') h.integration.core.gated = true
      await h.conn.welcomeBuiltin('D1', h.agent, h.integration)
      expect(h.history, change).not.toHaveBeenCalled()
      expect(h.postMessage, change).not.toHaveBeenCalled()
      expect(h.apiCall, change).not.toHaveBeenCalled()
    }
  })

  it('ignores other tabs and never posts a greeting when history cannot be checked', async () => {
    const h = fixture()
    await h.conn.start()
    await h.events.get('app_home_opened')!({ event: { channel: 'D1', tab: 'home' } })
    expect(h.history).not.toHaveBeenCalled()
    h.history.mockRejectedValueOnce(new Error('temporarily unavailable'))
    await h.conn.welcomeBuiltin('D1', h.agent, h.integration)
    expect(h.postMessage).not.toHaveBeenCalled()
    await h.conn.welcomeBuiltin('D1', h.agent, h.integration)
    expect(h.postMessage).toHaveBeenCalledTimes(1)
    await h.conn.stop()
  })
})
