import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { MAX_STEERS_PER_TURN } from '../src/daemon/constants.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { sessionKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

// Issue #1847: a message for a session whose turn is still running is steered into that turn
// over `_session/steering` when the runtime can take it, and queued exactly as before when it
// cannot. These drive `dispatch` directly with a host whose prompt blocks until released.

function scaffold(features: Record<string, boolean> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-steer-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: true, ...features },
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

const msg = (ts: string, body: string, over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
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
  trigger: 'dm' as const,
  ...over
})

/** A host whose prompts block until released, with steering wired through `steer`. */
function steeringHost(opts: { supported?: boolean; steer?: () => Promise<string> } = {}) {
  const releases: Array<() => void> = []
  const prompts: string[] = []
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async (_sid: string, blocks: { text?: string }[]) => {
      prompts.push(blocks.map((b) => b.text ?? '').join('\n'))
      await new Promise<void>((r) => releases.push(r))
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    ...(opts.supported === false
      ? {}
      : {
          steeringSupported: vi.fn(() => true),
          steer: vi.fn(opts.steer ?? (async () => 'injected'))
        })
  }
  return { host, prompts, releaseOne: () => releases.shift()?.() }
}

async function boot(host: unknown, features?: Record<string, boolean>) {
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root: scaffold(features),
    hostFactory: () => host as any
  })
  await daemon.start()
  return daemon
}

const keyFor = (first: NormalizedMessage) => sessionKey('slack', 'C1', 'T1', 'bot-a', first.transportScope)

/** Keep releasing blocked prompts until every dispatch has settled — a queued follow-up may run
 *  as its own turn or be folded into a regeneration of the head, and both block on the host. */
async function settleAll(h: ReturnType<typeof steeringHost>, promises: Promise<unknown>[]): Promise<unknown[]> {
  let settled = false
  const all = Promise.all(promises).finally(() => (settled = true))
  while (!settled) {
    h.releaseOne()
    await new Promise((r) => setTimeout(r, 20))
  }
  return all
}

describe('mid-turn session steering', () => {
  it('steers a same-session arrival into the running prompt instead of queueing it', async () => {
    const h = steeringHost()
    const daemon = await boot(h.host)
    const first = msg('100.1', 'original request')
    const p1 = (daemon as any).dispatch('bot-a', first, 'int-a')
    await vi.waitFor(() => expect(h.host.prompt).toHaveBeenCalledOnce(), WAIT)
    const key = keyFor(first)

    const p2 = (daemon as any).dispatch('bot-a', msg('100.2', 'use the staging database instead'), 'int-a')
    // The follow-up settles while the first prompt is STILL blocked — it rode the live turn.
    await expect(p2).resolves.toBe('acp-1')
    expect(h.host.steer).toHaveBeenCalledOnce()
    const [sessionId, blocks, steerOpts] = (h.host.steer as any).mock.calls[0]
    expect(sessionId).toBe('acp-1')
    expect(blocks).toEqual([{ type: 'text', text: '[U1] use the staging database instead' }])
    expect(steerOpts).toEqual({ idleBehavior: 'promptRequired' })
    // No queue entry and no durable row survive; the turn keeps its gate.
    expect((daemon as any).serialQueue.has(key)).toBe(false)
    const inbox = await (daemon as any).store.listInboxBySessionKeyFifo()
    expect(inbox.map((row: { id: string }) => row.id)).toEqual(['slack:C1:100.1'])
    expect((daemon as any).inflight.has(key)).toBe(true)
    expect(h.host.prompt).toHaveBeenCalledOnce()

    // The steered row is already in the ACP session: the final fence must not regenerate for it.
    h.releaseOne()
    await expect(p1).resolves.toBe('acp-1')
    await vi.waitFor(() => expect((daemon as any).inflight.has(key)).toBe(false), WAIT)
    expect(h.host.prompt).toHaveBeenCalledOnce()
    await daemon.stop()
  })

  it('falls back to the queue when the runtime declines, the call fails, or the runtime cannot steer', async () => {
    for (const variant of ['declined', 'threw', 'unsupported'] as const) {
      const h =
        variant === 'unsupported'
          ? steeringHost({ supported: false })
          : steeringHost({
              steer:
                variant === 'declined'
                  ? async () => 'failed'
                  : async () => {
                      throw new Error('transport closed')
                    }
            })
      const daemon = await boot(h.host)
      const first = msg('100.1', 'original request')
      const p1 = (daemon as any).dispatch('bot-a', first, 'int-a')
      await vi.waitFor(() => expect(h.host.prompt).toHaveBeenCalledOnce(), WAIT)
      const key = keyFor(first)

      const p2 = (daemon as any).dispatch('bot-a', msg('100.2', 'follow-up'), 'int-a')
      await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1), WAIT)
      if (variant !== 'unsupported') expect(h.host.steer).toHaveBeenCalledOnce()
      // Queued as before: it runs (or is folded into a regeneration) only after the head settles.
      await expect(settleAll(h, [p1, p2])).resolves.toEqual(['acp-1', 'acp-1'])
      expect(h.host.prompt).toHaveBeenCalledTimes(2)
      await daemon.stop()
    }
  })

  it('keeps `!queue`, scheduler wakes, and the feature switch on the serial queue', async () => {
    const h = steeringHost()
    const daemon = await boot(h.host)
    const first = msg('100.1', 'original request')
    const p1 = (daemon as any).dispatch('bot-a', first, 'int-a')
    await vi.waitFor(() => expect(h.host.prompt).toHaveBeenCalledOnce(), WAIT)
    const key = keyFor(first)

    const queued = (daemon as any).dispatch('bot-a', msg('100.2', 'park this'), 'int-a', undefined, undefined, {
      isQueueCmd: true
    })
    const cron = (daemon as any).dispatch('bot-a', msg('100.3', 'scheduled check', { source: 'cron' }), 'int-a')
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(2), WAIT)
    expect(h.host.steer).not.toHaveBeenCalled()

    await expect(settleAll(h, [p1, queued, cron])).resolves.toEqual(['acp-1', 'acp-1', 'acp-1'])
    expect(h.host.steer).not.toHaveBeenCalled()
    await daemon.stop()

    const off = steeringHost()
    const disabled = await boot(off.host, { sessionSteering: false })
    const head = msg('100.1', 'original request')
    const d1 = (disabled as any).dispatch('bot-a', head, 'int-a')
    await vi.waitFor(() => expect(off.host.prompt).toHaveBeenCalledOnce(), WAIT)
    const d2 = (disabled as any).dispatch('bot-a', msg('100.2', 'follow-up'), 'int-a')
    await vi.waitFor(() => expect((disabled as any).serialQueue.get(keyFor(head))).toHaveLength(1), WAIT)
    await expect(settleAll(off, [d1, d2])).resolves.toEqual(['acp-1', 'acp-1'])
    expect(off.host.steer).not.toHaveBeenCalled()
    await disabled.stop()
  })

  it('queues once a turn has spent its steering budget', async () => {
    const h = steeringHost()
    const daemon = await boot(h.host)
    const first = msg('100.1', 'original request')
    const p1 = (daemon as any).dispatch('bot-a', first, 'int-a')
    await vi.waitFor(() => expect(h.host.prompt).toHaveBeenCalledOnce(), WAIT)
    const key = keyFor(first)
    const [live] = [...(daemon as any).pending.values()]
    live.steerCount = MAX_STEERS_PER_TURN

    const p2 = (daemon as any).dispatch('bot-a', msg('100.2', 'one too many'), 'int-a')
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1), WAIT)
    expect(h.host.steer).not.toHaveBeenCalled()
    await expect(settleAll(h, [p1, p2])).resolves.toEqual(['acp-1', 'acp-1'])
    expect(h.host.prompt).toHaveBeenCalledTimes(2)
    await daemon.stop()
  })

  it('steers while the turn is parked on session/request_permission — the runtime holds it', async () => {
    const h = steeringHost()
    const daemon = await boot(h.host)
    const first = msg('100.1', 'original request')
    const p1 = (daemon as any).dispatch('bot-a', first, 'int-a')
    await vi.waitFor(() => expect(h.host.prompt).toHaveBeenCalledOnce(), WAIT)
    const key = keyFor(first)

    // The prompt is awaiting the runtime, which is awaiting the human.
    const approval = (daemon as any).permissions.onAcpPermission('bot-a', 'acp-1', {
      sessionId: 'acp-1',
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
      ],
      toolCall: { toolCallId: 'tc-1', title: 'Bash' }
    })
    await vi.waitFor(() => expect((daemon as any).permissions.pendingEditorPermissions.size).toBe(1), WAIT)

    const p2 = (daemon as any).dispatch('bot-a', msg('100.2', 'skip the migration step'), 'int-a')
    await expect(p2).resolves.toBe('acp-1')
    expect(h.host.steer).toHaveBeenCalledOnce()
    expect((daemon as any).serialQueue.has(key)).toBe(false)

    const [requestId] = (daemon as any).permissions.pendingEditorPermissions.keys()
    await (daemon as any).permissions.decideEditorPermission({ agentId: 'bot-a', requestId, decision: 'allow' })
    await approval
    h.releaseOne()
    await expect(p1).resolves.toBe('acp-1')
    expect(h.host.prompt).toHaveBeenCalledOnce()
    await daemon.stop()
  })
})
