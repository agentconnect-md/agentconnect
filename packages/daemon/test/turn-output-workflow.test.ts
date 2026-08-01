import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-turn-output-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: true },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const agentDir = join(root, 'agents', 'bot-a')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'low' }
    })
  )
  return root
}

const msg = (ts: string, body: string): NormalizedMessage => ({
  msgId: `slack:C1:${ts}`,
  traceId: ts,
  source: 'user' as const,
  platform: 'slack' as const,
  channel: 'C1',
  thread: 'T1',
  sender: { id: 'U1', isBot: false },
  text: body,
  mentionedBots: [] as string[],
  isDm: true,
  trigger: 'dm' as const
})

function connect(daemon: Daemon, overrides: Record<string, unknown> = {}) {
  const agent = (daemon as any).agents.get('bot-a')
  agent.integrations = [
    {
      id: 'int-a',
      platform: 'slack',
      slack: { botToken: 'b', appToken: 'p', allowedUserIds: [], bindRules: [{ match: { kind: 'dm' } }] }
    }
  ]
  let post = 0
  const conn = {
    workspaceId: vi.fn(() => 'T1'),
    setStatus: vi.fn(async () => {}),
    postMessage: vi.fn(async () => `reply-${++post}`),
    postBlocks: vi.fn(async () => 'status-bar'),
    updateBlocks: vi.fn(async () => {}),
    ...overrides
  }
  ;(daemon as any).connByIntegration.set('int-a', conn)
  return conn
}

describe('TurnOutputWorkflow', () => {
  it('discards a stale candidate, regenerates in the same ACP session, and publishes only the replacement', async () => {
    let onUpdate!: (sessionId: string, update: unknown) => void
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve))
    const prompts: string[] = []
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string, blocks: { text?: string }[]) => {
        prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
        if (prompts.length === 1) {
          onUpdate(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'stale candidate' }
          })
          await firstBlocked
        } else {
          onUpdate(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'fresh replacement' }
          })
        }
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      }
    })
    await daemon.start()
    const conn = connect(daemon)

    const firstMessage = msg('100.1', 'original request')
    const first = (daemon as any).dispatch('bot-a', firstMessage, 'int-a')
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1))
    expect(conn.postMessage).not.toHaveBeenCalled()

    const clarificationMessage = msg('100.2', 'important clarification')
    const clarification = (daemon as any).dispatch('bot-a', clarificationMessage, 'int-a')
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a', firstMessage.transportScope)
    expect((daemon as any).serialQueue.get(key)).toHaveLength(1)
    releaseFirst()

    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2))
    await expect(first).resolves.toBe('acp-1')
    await expect(clarification).resolves.toBe('acp-1')

    expect(prompts[1]).toContain('AgentConnect context update')
    expect(prompts[1]).toContain('important clarification')
    const publishedBodies = conn.postMessage.mock.calls.map((call) => String(call[1]))
    expect(publishedBodies).toContain('fresh replacement')
    expect(publishedBodies.join('\n')).not.toContain('stale candidate')
    const replies = (daemon as any).store
      .transcriptSince(transcriptChannelKey('C1', firstMessage.transportScope), 'T1', null)
      .filter((row: any) => row.sender === 'bot-a')
      .map((row: any) => row.text)
    expect(replies).toEqual(['fresh replacement'])
    expect((daemon as any).serialQueue.has(key)).toBe(false)

    await daemon.stop()
  }, 15_000)

  it('coalesces a clarification represented in the first prompt before initiating it', async () => {
    let onUpdate!: (sessionId: string, update: unknown) => void
    let release!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const prompts: string[] = []
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string, blocks: { text?: string }[]) => {
        prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
        onUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'one combined answer' }
        })
        await blocked
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      }
    })
    await daemon.start()
    connect(daemon)

    const firstMessage = msg('100.1', 'original request')
    const first = (daemon as any).dispatch('bot-a', firstMessage, 'int-a')
    const clarification = (daemon as any).dispatch('bot-a', msg('100.2', 'pre-prompt clarification'), 'int-a')
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a', firstMessage.transportScope)

    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledOnce())
    expect(prompts[0]).toContain('original request')
    expect(prompts[0]).toContain('pre-prompt clarification')
    expect((daemon as any).serialQueue.has(key)).toBe(false)
    await expect(clarification).resolves.toBe('acp-1')

    release()
    await expect(first).resolves.toBe('acp-1')
    expect(host.prompt).toHaveBeenCalledOnce()
    expect((daemon as any).store.listInboxBySessionKeyFifo()).toEqual([])

    await daemon.stop()
  }, 15_000)

  it('does not commit a staged candidate when cancellation arrives during the final snapshot', async () => {
    let onUpdate!: (sessionId: string, update: unknown) => void
    let releaseSnapshot!: () => void
    let snapshotStarted!: () => void
    const snapshotBlocked = new Promise<void>((resolve) => (releaseSnapshot = resolve))
    const snapshotPending = new Promise<void>((resolve) => (snapshotStarted = resolve))
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string) => {
        onUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'must remain private' }
        })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      }
    })
    await daemon.start()
    const conn = connect(daemon, {
      getThreadReplies: vi.fn(async () => {
        snapshotStarted()
        await snapshotBlocked
        return []
      })
    })

    const message = msg('100.1', 'original request')
    const turn = (daemon as any).dispatch('bot-a', message, 'int-a')
    await snapshotPending
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a', message.transportScope)
    ;(daemon as any).interruptTurn('bot-a', key, 'cancel', 'acp-1')
    releaseSnapshot()

    await expect(turn).resolves.toBeNull()
    expect(conn.postMessage).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('must remain private'))

    await daemon.stop()
  }, 15_000)
})
