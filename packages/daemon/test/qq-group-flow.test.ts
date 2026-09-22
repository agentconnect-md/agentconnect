import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiClient, TokenManager } from '@tencent-connect/qqbot-nodejs/protocol'
import { normalizeQQMessage } from '@agentconnect.md/message'
import { Daemon } from '../src/daemon.js'
import { QQConnection } from '../src/platforms/qq/connection.js'

let daemon: Daemon | undefined
let root: string | undefined
afterEach(async () => {
  await daemon?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('QQ group loop through the daemon', () => {
  it('quotes progress and answers in a shared group session, isolates other chats and ignores duplicates', async () => {
    root = mkdtempSync(join(tmpdir(), 'ac-qq-group-'))
    const dir = join(root, 'agents', 'qq-agent')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { opencode: { command: 'node', args: ['unused'] } }
      })
    )
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        id: 'qq-agent',
        name: 'QQ Agent',
        runtime: 'opencode',
        status: 'active',
        workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
        integrations: [
          {
            id: 'qq-install',
            platform: 'qq',
            core: { mode: 'direct', bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }] },
            config: { appId: '100', appSecret: 'secret' }
          }
        ],
        output: { mode: 'high' }
      })
    )
    vi.spyOn(QQConnection.prototype, 'start').mockResolvedValue()
    vi.spyOn(TokenManager.prototype, 'getAccessToken').mockResolvedValue('token')
    const request = vi.spyOn(ApiClient.prototype, 'request').mockResolvedValue({ id: 'reply' })
    const prompts: { session: string; text: string }[] = []
    let sessions = 0
    daemon = new Daemon({
      root,
      hostFactory: (_agent, update) =>
        ({
          start: async () => {},
          stop: async () => {},
          cancel: async () => {},
          newSession: async () => `session-${++sessions}`,
          prompt: async (session: string, blocks: { text?: string }[]) => {
            prompts.push({ session, text: blocks.map((block) => block.text ?? '').join('\n') })
            if (prompts.length === 1) {
              update(session, {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Checking the request.' }
              })
              update(session, {
                sessionUpdate: 'tool_call',
                toolCallId: 'check',
                title: 'Check',
                status: 'in_progress'
              })
              await vi.waitFor(() => expect(posts()).toHaveLength(1))
              expect(posts()[0]![3]).toMatchObject({
                markdown: { content: 'Checking the request.' },
                message_reference: { message_id: 'm1' }
              })
            }
            for (const text of ['hello ', 'group'])
              update(session, {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text }
              })
            return 'end_turn'
          }
        }) as any
    })
    await daemon.start()
    await vi.waitFor(() => expect((daemon as any).QQConnByIntegration.size).toBe(1))
    const deliver = async (group: string | undefined, user: string, id: string, ambient = false) => {
      const message = normalizeQQMessage(
        '100',
        {
          rawEventType: group ? (ambient ? 'GROUP_MESSAGE_CREATE' : 'GROUP_AT_MESSAGE_CREATE') : 'C2C_MESSAGE_CREATE',
          kind: group ? 'group' : 'c2c',
          groupOpenid: group,
          senderId: user,
          senderName: user,
          messageId: id,
          content: ambient ? '!cancel' : `${group ? '<@!100> ' : ''}request from ${user}`
        },
        `trace-${id}`
      )
      if (message) await (daemon as any).onInboundOutcome(message, ['qq-install'])
    }
    const posts = () => request.mock.calls.filter((call) => (call[3] as { msg_type?: number })?.msg_type === 2)
    await deliver('g1', 'Alice', 'm1')
    await vi.waitFor(() => expect(posts()).toHaveLength(2), { timeout: 5000 })
    await deliver('g1', 'Alice', 'm1')
    await deliver('g1', 'Bob', 'ambient', true)
    await deliver('g1', 'Bob', 'm2')
    await vi.waitFor(() => expect(posts()).toHaveLength(3), { timeout: 5000 })
    await deliver('g2', 'Alice', 'm1')
    await vi.waitFor(() => expect(posts()).toHaveLength(4), { timeout: 5000 })
    expect(prompts).toHaveLength(3)
    expect(prompts[0]!.session).toBe(prompts[1]!.session)
    expect(prompts[2]!.session).not.toBe(prompts[0]!.session)
    expect(prompts[0]!.text).toContain('request from Alice')
    expect(prompts[1]!.text).toContain('request from Bob')
    expect(
      posts()
        .slice(1)
        .map((call) => [call[2], call[3]])
    ).toEqual(
      [
        ['g1', 'm1'],
        ['g1', 'm2'],
        ['g2', 'm1']
      ].map(([group, message]) => [
        `/v2/groups/${group}/messages`,
        expect.objectContaining({
          markdown: { content: 'hello group' },
          msg_id: message,
          message_reference: { message_id: message }
        })
      ])
    )
    expect(request.mock.calls.some((call) => call[2].endsWith('/stream_messages'))).toBe(false)
    await deliver(undefined, 'Alice', 'm1')
    await vi.waitFor(() => expect(request.mock.calls.some((call) => call[2].startsWith('/v2/users/Alice/'))).toBe(true))
    expect(request.mock.calls.filter((call) => (call[3] as { msg_type?: number })?.msg_type === 0)).toHaveLength(3)
    expect(prompts).toHaveLength(4)
    expect(prompts[3]!.session).not.toBe(prompts[0]!.session)
    expect(prompts[3]!.session).not.toBe(prompts[2]!.session)
  })
})
