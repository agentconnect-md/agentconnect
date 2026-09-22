import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiClient, TokenManager } from '@tencent-connect/qqbot-nodejs/protocol'
import { Daemon } from '../src/daemon.js'
import { QQConnection } from '../src/platforms/qq/connection.js'
import { normalizeQQMessage } from '@agentconnect.md/message'

let daemon: Daemon | undefined
let root: string | undefined
afterEach(async () => {
  await daemon?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('QQ private text loop through the daemon', () => {
  it('reuses a user session, isolates different users and ignores duplicate deliveries', async () => {
    const runtime = 'opencode'
    root = mkdtempSync(join(tmpdir(), 'ac-qq-'))
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { [runtime]: { command: 'node', args: ['unused'] } }
      })
    )
    const dir = join(root, 'agents', 'qq-agent')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        id: 'qq-agent',
        name: 'QQ Agent',
        runtime,
        status: 'active',
        workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
        integrations: [
          {
            id: 'qq-install',
            platform: 'qq',
            core: { mode: 'direct', bindRules: [{ match: { kind: 'dm' } }] },
            config: { appId: '100', appSecret: 'secret' }
          }
        ],
        output: { mode: 'high' }
      })
    )
    vi.spyOn(QQConnection.prototype, 'start').mockResolvedValue()
    vi.spyOn(TokenManager.prototype, 'getAccessToken').mockResolvedValue('test-token')
    const request = vi.spyOn(ApiClient.prototype, 'request').mockResolvedValue({ id: 'reply' })
    let sessions = 0
    const prompts: string[] = []
    daemon = new Daemon({
      root,
      hostFactory: (_agent, update) =>
        ({
          start: async () => {},
          stop: async () => {},
          cancel: async () => {},
          newSession: async () => `session-${++sessions}`,
          prompt: async (id: string) => {
            prompts.push(id)
            for (const text of ['po', 'ng'])
              update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
            return 'end_turn'
          }
        }) as any
    })
    await daemon.start()
    await vi.waitFor(() => expect((daemon as any).QQConnByIntegration.size).toBe(1))
    const deliver = async (user: string, id: string) => {
      const outcome = await (daemon as any).onInboundOutcome(
        normalizeQQMessage(
          '100',
          { rawEventType: 'C2C_MESSAGE_CREATE', kind: 'c2c', senderId: user, messageId: id, content: 'reply pong' },
          'trace'
        ),
        ['qq-install']
      )
      if (outcome.kind === 'dispatched') await outcome.handle.completion
    }
    await deliver('u1', 'm1')
    await deliver('u1', 'm1')
    expect(prompts).toHaveLength(1)
    await deliver('u1', 'm2')
    await deliver('u2', 'm3')
    expect(prompts).toHaveLength(3)
    expect(prompts[0]).toBe(prompts[1])
    expect(prompts[2]).not.toBe(prompts[0])
    expect(request.mock.calls.map((call) => [call[2], call[3]])).toEqual(
      [
        ['u1', 'm1'],
        ['u1', 'm2'],
        ['u2', 'm3']
      ].map(([user, msg_id]) => [
        `/v2/users/${user}/messages`,
        { msg_type: 2, markdown: { content: 'pong' }, msg_id, msg_seq: 1 }
      ])
    )
  })
})
