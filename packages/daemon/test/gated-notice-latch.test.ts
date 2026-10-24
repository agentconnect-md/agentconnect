// The gated notice's once-only latch on a platform posting through its chrome surface (resource-visibility.md §14.3).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

const GATED = '🔒 This agent isn’t enabled in this conversation. Ask an admin to enable it in the AgentConnect console.'

function message(platform: string, channel: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    msgId: `${platform}:${channel}:1`,
    traceId: `${platform}:${channel}:1`,
    source: 'user',
    platform,
    channel,
    thread: 'thread-1',
    sender: { id: 'user-1', isBot: false, name: 'Example Person' },
    text: 'hello',
    mentionedBots: [],
    isDm: false,
    trigger: 'mention',
    ...extra
  } as NormalizedMessage
}

describe('the gated notice latch', () => {
  let root: string | undefined
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  it('answers each DingTalk message once, and a failed post leaves that message unanswered for a retry', async () => {
    root = mkdtempSync(join(tmpdir(), 'ac-gated-notice-'))
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ version: 1, controlPlane: { enabled: false }, runtimes: {} })
    )
    const daemon = new Daemon({ root, hostFactory: () => ({}) as any })
    const integration = {
      id: 'int-dingtalk',
      platform: 'dingtalk',
      core: { mode: 'shared', gated: true, bindRules: [] }
    }
    ;(daemon as any).integrationConfigById = (id: string) => (id === integration.id ? integration : undefined)
    const sendText = vi.fn<(channel: string, text: string) => Promise<string | undefined>>()
    sendText.mockResolvedValueOnce(undefined).mockResolvedValue('query-key')
    ;(daemon as any).dingTalkConnByIntegration.set(integration.id, { sendText })
    const notice = (n: number) =>
      (daemon as any).maybeGatedNotice(message('dingtalk', 'group:example', { msgId: `m${n}` }), [integration.id])

    notice(1)
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect((daemon as any).gatedNoticesSent.size).toBe(0))
    // The failed message's redelivery is answered; its second copy posts nothing more.
    notice(1)
    notice(1)
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(2))
    notice(2)
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(3))
    expect(sendText).toHaveBeenLastCalledWith('group:example', GATED)
  })

  it('answers the same message id on two bots, since an id is unique only per bot connection', async () => {
    root = mkdtempSync(join(tmpdir(), 'ac-gated-notice-'))
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ version: 1, controlPlane: { enabled: false }, runtimes: {} })
    )
    const daemon = new Daemon({ root, hostFactory: () => ({}) as any })
    const integrations = ['int-a', 'int-b'].map((id) => ({
      id,
      platform: 'dingtalk',
      core: { mode: 'shared', gated: true, bindRules: [] }
    }))
    ;(daemon as any).integrationConfigById = (id: string) => integrations.find((i) => i.id === id)
    const sends = integrations.map((i) => {
      const sendText = vi.fn(async () => 'query-key')
      ;(daemon as any).dingTalkConnByIntegration.set(i.id, { sendText })
      return sendText
    })
    const msg = message('dingtalk', 'group:example', { msgId: 'm1' })
    ;(daemon as any).maybeGatedNotice(msg, ['int-a'])
    ;(daemon as any).maybeGatedNotice(msg, ['int-b'])
    await vi.waitFor(() => expect(sends.map((s) => s.mock.calls.length)).toEqual([1, 1]))
  })
})
