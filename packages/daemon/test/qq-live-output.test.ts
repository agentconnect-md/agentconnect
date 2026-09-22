import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiClient, TokenManager } from '@tencent-connect/qqbot-nodejs/protocol'
import { normalizeQQMessage } from '@agentconnect.md/message'
import { Daemon } from '../src/daemon.js'
import { QQConnection } from '../src/platforms/qq/connection.js'
import { sessionKey } from '../src/store/local-store.js'

let daemon: Daemon | undefined
let root: string | undefined
const releases: Array<() => void> = []
const WAIT = { timeout: 5000 }

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await daemon?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function QQGate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  releases.push(release)
  return { promise, release }
}

function QQMessage(id: string, content: string) {
  return normalizeQQMessage(
    '100',
    {
      rawEventType: 'C2C_MESSAGE_CREATE',
      kind: 'c2c',
      senderId: 'u',
      messageId: id,
      content
    },
    `trace-${id}`
  )!
}

const QQUpdate = (text: string) => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
  _meta: { codex: { phase: 'final_answer' } }
})

type QQHostFactory = NonNullable<NonNullable<ConstructorParameters<typeof Daemon>[0]>['hostFactory']>

async function bootQQ(hostFactory: QQHostFactory) {
  root = mkdtempSync(join(tmpdir(), 'ac-qq-live-'))
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
  daemon = new Daemon({ root, hostFactory })
  await daemon.start()
  await vi.waitFor(() => expect((daemon as any).QQConnByIntegration.size).toBe(1), WAIT)
  const scope = (daemon as any).transportScopeForIntegrationIds(['qq-install'])
  const key = sessionKey('qq', 'dm:u', 'dm', 'qq-agent', scope)
  const dispatch = (id: string, text: string): Promise<string | null> =>
    (daemon as any).dispatch('qq-agent', QQMessage(id, text), 'qq-install')
  const frames = () =>
    request.mock.calls
      .filter((call) => call[2].endsWith('/stream_messages'))
      .map((call) => call[3] as { content_raw: string; input_state: number })
  return { dispatch, frames, key, request }
}

describe('QQ live delivery with default daemon features', () => {
  it('streams phase-less output before the prompt completes and closes with the full answer', async () => {
    const blocked = QQGate()
    const prompt = vi.fn()
    const test = await bootQQ(
      (_agent, update) =>
        ({
          start: async () => {},
          stop: async () => {},
          cancel: async () => blocked.release(),
          newSession: async () => 'acp-1',
          prompt: async (sid: string) => {
            prompt()
            update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First part' } })
            await blocked.promise
            update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' and the ending.' } })
            return { stopReason: 'end_turn' }
          }
        }) as any
    )
    const turn = test.dispatch('m1', 'reply in several parts')
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce(), WAIT)
    await vi.waitFor(
      () => expect(test.frames()).toEqual([expect.objectContaining({ content_raw: 'First part', input_state: 1 })]),
      WAIT
    )
    blocked.release()
    await expect(turn).resolves.toBe('acp-1')
    expect(test.frames().map(({ content_raw, input_state }) => [content_raw, input_state])).toEqual([
      ['First part', 1],
      ['First part and the ending.', 10]
    ])
    expect(test.request).toHaveBeenCalledTimes(2)
    expect(prompt).toHaveBeenCalledOnce()
  })

  it('refreshes and absorbs a clarification that arrives before the first prompt', async () => {
    const ready = QQGate()
    const prompt = vi.fn(async (_sid: string, _blocks: { text?: string }[]) => 'end_turn')
    const start = vi.fn(async () => {
      await ready.promise
    })
    const test = await bootQQ(
      (_agent, update) =>
        ({
          start,
          stop: async () => {},
          cancel: async () => {},
          newSession: async () => 'acp-1',
          hasSession: () => true,
          prompt: async (sid: string, blocks: { text?: string }[]) => {
            await prompt(sid, blocks)
            update(sid, QQUpdate('Combined answer'))
            return { stopReason: 'end_turn' }
          }
        }) as any
    )
    const first = test.dispatch('m1', 'original request')
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce(), WAIT)
    const second = test.dispatch('m2', 'use Python instead')
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(test.key)).toHaveLength(1), WAIT)
    ready.release()
    await expect(Promise.all([first, second])).resolves.toEqual(['acp-1', 'acp-1'])
    expect(prompt).toHaveBeenCalledOnce()
    const text = prompt.mock.calls[0]![1].map((block) => block.text ?? '').join('\n')
    expect(text).toContain('original request')
    expect(text).toContain('use Python instead')
    expect((daemon as any).serialQueue.has(test.key)).toBe(false)
    expect(await (daemon as any).store.listInboxBySessionKeyFifo()).toEqual([])
  })

  it.each(['injected', 'failed'] as const)('handles mid-stream clarification when steering is %s', async (outcome) => {
    const blocked = QQGate()
    const prompt = vi.fn(async (_sid: string, _blocks: { text?: string }[]) => {})
    const steer = vi.fn(async () => outcome)
    const test = await bootQQ(
      (_agent, update) =>
        ({
          start: async () => {},
          stop: async () => {},
          cancel: async () => {
            blocked.release()
          },
          newSession: async () => 'acp-1',
          hasSession: () => true,
          steeringSupported: () => true,
          steer,
          prompt: async (sid: string, blocks: { text?: string }[]) => {
            await prompt(sid, blocks)
            if (prompt.mock.calls.length === 1) {
              update(sid, QQUpdate('Initial response'))
              await blocked.promise
              if (outcome === 'injected') update(sid, QQUpdate('\nUpdated for Python'))
            } else update(sid, QQUpdate('Queued follow-up'))
            return { stopReason: 'end_turn' }
          }
        }) as any
    )
    const first = test.dispatch('m1', 'original request')
    await vi.waitFor(
      () =>
        expect(test.frames()).toEqual([expect.objectContaining({ content_raw: 'Initial response', input_state: 1 })]),
      WAIT
    )
    const second = test.dispatch('m2', 'use Python instead')
    await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce(), WAIT)
    if (outcome === 'injected') await expect(second).resolves.toBe('acp-1')
    else await vi.waitFor(() => expect((daemon as any).serialQueue.get(test.key)).toHaveLength(1), WAIT)
    expect(prompt).toHaveBeenCalledOnce()
    blocked.release()
    await expect(Promise.all([first, second])).resolves.toEqual(['acp-1', 'acp-1'])
    expect(prompt).toHaveBeenCalledTimes(outcome === 'injected' ? 1 : 2)
    expect(test.frames().map(({ content_raw, input_state }) => [content_raw, input_state])).toEqual([
      ['Initial response', 1],
      [outcome === 'injected' ? 'Initial response\nUpdated for Python' : 'Initial response', 10]
    ])
    if (outcome === 'failed') {
      const followUp = prompt.mock.calls[1]![1].map((block) => block.text ?? '').join('\n')
      expect(followUp).toContain('use Python instead')
      expect(followUp).not.toContain('Your previous candidate answer was not delivered')
      expect(test.request.mock.calls.at(-1)![3]).toMatchObject({
        msg_type: 2,
        markdown: { content: 'Queued follow-up' }
      })
    }
    expect(await (daemon as any).store.listInboxBySessionKeyFifo()).toEqual([])
  })

  it('closes confirmed content on cancellation and suppresses late runtime text', async () => {
    const blocked = QQGate()
    const cancel = vi.fn(async () => {
      blocked.release()
    })
    const test = await bootQQ(
      (_agent, update) =>
        ({
          start: async () => {},
          stop: async () => {},
          cancel,
          newSession: async () => 'acp-1',
          hasSession: () => true,
          prompt: async (sid: string) => {
            update(sid, QQUpdate('Visible prefix'))
            await blocked.promise
            update(sid, QQUpdate(' must not appear'))
            return { stopReason: 'cancelled' }
          }
        }) as any
    )
    const turn = test.dispatch('m1', 'original request')
    await vi.waitFor(() => expect(test.frames()).toHaveLength(1), WAIT)
    await (daemon as any).interruptTurn('qq-agent', test.key, 'cancel', 'acp-1')
    await expect(turn).resolves.toBeNull()
    expect(cancel).toHaveBeenCalledOnce()
    expect(test.frames().map(({ content_raw, input_state }) => [content_raw, input_state])).toEqual([
      ['Visible prefix', 1],
      ['Visible prefix', 10]
    ])
    expect(test.request.mock.calls).toHaveLength(2)
  })
})
