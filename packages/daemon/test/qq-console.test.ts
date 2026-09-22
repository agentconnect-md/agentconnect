import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, TokenManager } from '@tencent-connect/qqbot-nodejs/protocol'
import type { RdChatEvent, RdMsgWebchat } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { QQConnection } from '../src/platforms/qq/connection.js'
import { sessionKey, transcriptChannelKey } from '../src/store/local-store.js'

let daemon: Daemon | undefined
let root: string | undefined
const WAIT = { timeout: 5000 }

afterEach(async () => {
  await daemon?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function bootQQConsole(channel: string, thread: string) {
  root = mkdtempSync(join(tmpdir(), 'ac-qq-console-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const dir = join(root, 'agents', 'qq-agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({
      id: 'qq-agent',
      name: 'QQ Agent',
      runtime: 'claude',
      status: 'active',
      workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
      integrations: [
        {
          id: 'qq-install',
          platform: 'qq',
          core: { mode: 'direct', bindRules: [{ match: { kind: 'mention' } }] },
          config: { appId: '100', appSecret: 'secret' }
        }
      ],
      output: { mode: 'high' }
    })
  )
  vi.spyOn(QQConnection.prototype, 'start').mockResolvedValue()
  vi.spyOn(TokenManager.prototype, 'getAccessToken').mockResolvedValue('test-token')
  const request = vi.spyOn(ApiClient.prototype, 'request').mockResolvedValue({ id: 'unused' })
  const prompt = vi.fn(async () => {})
  daemon = new Daemon({
    root,
    hostFactory: () =>
      ({
        start: async () => {},
        stop: async () => {},
        cancel: async () => {},
        hasSession: () => true,
        newSession: async () => 'target-acp',
        prompt
      }) as any
  })
  await daemon.start()
  const d = daemon as any
  await vi.waitFor(() => expect(d.QQConnByIntegration.size).toBe(1), WAIT)
  const scope = d.transportScopeForIntegrationIds(['qq-install'])
  const key = sessionKey('qq', channel, thread, 'qq-agent', scope)
  await d.store.upsertSession({
    key,
    agentId: 'qq-agent',
    platform: 'qq',
    channel,
    thread,
    transportScope: scope,
    acpSessionId: 'target-acp',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  const events: RdChatEvent[] = []
  const send = (id = 'console-turn') =>
    d.handleRelayMsg(
      {
        source: 'webchat',
        agentId: 'qq-agent',
        sessionKey: 'console-chat',
        chatId: 'console-chat',
        msgId: id,
        targetSessionId: 'target-acp',
        payload: { op: 'turn', text: 'console request', user: 'Alice', userId: 'console-user' }
      } satisfies RdMsgWebchat,
      (event: RdChatEvent) => events.push(event)
    )
  return { d, key, scope, events, send, request, prompt }
}

describe('QQ console read-only sessions', () => {
  it.each([
    ['group:g', 'group'],
    ['dm:u', 'dm']
  ])('refuses stale console sends to %s before calling QQ or running the agent', async (channel, thread) => {
    const { d, key, scope, events, send, request, prompt } = await bootQQConsole(channel, thread)
    expect(await send()).toMatchObject({ accepted: false, reason: 'not_found' })
    expect(prompt).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(events).toHaveLength(0)
    expect(d.inflight.has(key)).toBe(false)
    expect((await d.store.getSession(key))?.acpSessionId).toBe('target-acp')
    const page = await d.store.transcriptPage(transcriptChannelKey(channel, scope), thread, null, 50, 'qq-agent')
    expect(page.rows).toHaveLength(0)
  })
})
