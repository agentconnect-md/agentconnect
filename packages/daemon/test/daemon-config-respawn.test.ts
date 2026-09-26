import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionHostKey } from '../src/acp/host-key.js'
import { Daemon } from '../src/daemon.js'
import { LocalStore } from '../src/store/local-store.js'
import { statePath } from '../src/paths.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

// A runtime config change waits for running turns, holds new ones, and cuts stragglers for replay.
const AGENT_ID = 'bot-a'
const CONV = '11111111-1111-4111-8111-111111111111'
const REPLAYED = '⚠️ The agent is restarting to apply its new configuration — this message will be picked up again.'
const LOST = '⚠️ The agent restarted to apply its new configuration — this turn was stopped; send your message again.'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-config-respawn-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const agentDir = join(root, 'agents', AGENT_ID)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: AGENT_ID,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'low' }
    })
  )
  return root
}

function updateAgent(root: string, patch: Record<string, unknown>): void {
  const file = join(root, 'agents', AGENT_ID, 'agent.json')
  const current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, JSON.stringify({ ...current, ...patch }))
}

/** A runtime whose prompts block until released; a cancel yields the blocked prompt as cancelled. */
function blockingHost(name: string) {
  const blocked: Array<(value: unknown) => void> = []
  const prompts: string[] = []
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => `acp-${name}`),
    hasSession: vi.fn(() => true),
    modelOptions: vi.fn(() => null),
    prompt: vi.fn((_sid: string, blocks: { text?: string }[]) => {
      prompts.push(blocks.map((block) => block.text ?? '').join('|'))
      return new Promise((resolve) => blocked.push(resolve))
    }),
    cancel: vi.fn(async () => blocked.shift()?.({ stopReason: 'cancelled' })),
    stop: vi.fn(async () => {})
  }
  return { host, prompts, release: () => blocked.shift()?.({ stopReason: 'end_turn' }) }
}

/** A runtime whose session start never returns until the process is stopped. */
function stuckStartHost() {
  let fail!: (reason: Error) => void
  const session = new Promise<never>((_resolve, reject) => (fail = reject))
  void session.catch(() => {})
  return {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => session),
    hasSession: vi.fn(() => true),
    modelOptions: vi.fn(() => null),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => fail(new Error('host stopped')))
  }
}

/** A runtime that answers every prompt at once. */
function answeringHost(name: string) {
  const prompts: string[] = []
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => `acp-${name}`),
    hasSession: vi.fn(() => true),
    modelOptions: vi.fn(() => null),
    prompt: vi.fn(async (_sid: string, blocks: { text?: string }[]) => {
      prompts.push(blocks.map((block) => block.text ?? '').join('|'))
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
  return { host, prompts }
}

async function boot(root: string, hosts: unknown[]): Promise<Daemon> {
  const queue = [...hosts]
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => queue.shift() as any })
  await daemon.start()
  // Reconcile only when the test says so.
  await (daemon as any).watcher.close()
  ;(daemon as any).watcher = undefined
  return daemon
}

async function inboxIds(root: string): Promise<string[]> {
  const store = await LocalStore.open(statePath(root))
  const rows = await store.listInboxBySessionKeyFifo()
  await store.close()
  return rows.map((row) => row.id)
}

const msg = (ts: string, text: string, thread: string) => ({
  msgId: `slack:C1:${ts}`,
  traceId: ts,
  source: 'user' as const,
  platform: 'slack' as const,
  channel: 'C1',
  thread,
  sender: { id: 'U1', isBot: false },
  text,
  mentionedBots: [] as string[],
  isDm: true,
  trigger: 'dm' as const
})

describe('config change respawn', () => {
  it('lets a running turn finish on the old process and holds a new session for the new one', async () => {
    const old = blockingHost('old')
    const fresh = answeringHost('new')
    const root = scaffold()
    const daemon = await boot(root, [old.host, fresh.host])
    const running = (daemon as any).dispatch(AGENT_ID, msg('100', 'long question', 'T1'), 'int-a')
    let held: Promise<unknown> | undefined

    try {
      await vi.waitFor(() => expect(old.host.prompt).toHaveBeenCalledTimes(1), WAIT)

      // `description` ∈ hostSpawnSig: a respawn, which no longer cuts the running turn.
      updateAgent(root, { description: 'be terse' })
      await daemon.reconcile()
      expect(old.host.cancel).not.toHaveBeenCalled()
      expect(old.host.stop).not.toHaveBeenCalled()

      // Another session would start on the old process: it waits for the new one instead.
      held = (daemon as any).dispatch(AGENT_ID, msg('200', 'second session', 'T2'), 'int-a')
      await vi.waitFor(() => expect((daemon as any).respawnHeldEntries.size).toBe(1), WAIT)
      expect(fresh.host.start).not.toHaveBeenCalled()

      old.release()
      await expect(running).resolves.toBe('acp-old')
      await expect(held).resolves.toBe('acp-new')
      expect(old.host.stop).toHaveBeenCalledTimes(1)
      expect(fresh.prompts).toEqual([expect.stringContaining('second session')])
      expect(await inboxIds(root)).toEqual([])
    } finally {
      old.release()
      await Promise.allSettled([running, ...(held ? [held] : [])])
      await daemon.stop()
    }
  })

  it('keeps a running turn and its process when only the additional repositories or grants change', async () => {
    const old = blockingHost('old')
    const root = scaffold()
    const daemon = await boot(root, [old.host])
    const dropped = vi.spyOn((daemon as any).gitCreds, 'remove')
    const running = (daemon as any).dispatch(AGENT_ID, msg('100', 'long question', 'T1'), 'int-a')

    try {
      await vi.waitFor(() => expect(old.host.prompt).toHaveBeenCalledTimes(1), WAIT)
      const workspace = { mode: 'from-scratch', path: join(root, 'agents', AGENT_ID, 'workspace') }
      updateAgent(root, {
        workspace: {
          ...workspace,
          additionalInstallations: [
            { provider: 'github', accountLogin: 'example-org', access: 'read', materialize: 'decision' }
          ]
        }
      })
      await daemon.reconcile()

      // Only later sessions see the grant; the cached tokens go so the next request mints under it.
      expect(old.host.cancel).not.toHaveBeenCalled()
      expect(old.host.stop).not.toHaveBeenCalled()
      expect((daemon as any).respawnHeldEntries.size).toBe(0)
      expect(dropped).toHaveBeenCalledWith(AGENT_ID)

      old.release()
      await expect(running).resolves.toBe('acp-old')
      await (daemon as any).sweepIdle()
      expect(old.host.stop).not.toHaveBeenCalled()
    } finally {
      old.release()
      await Promise.allSettled([running])
      await daemon.stop()
    }
  })

  it('reclaims the shared process once idle when an always repository joins, without cutting its turn', async () => {
    const old = blockingHost('old')
    const root = scaffold()
    const daemon = await boot(root, [old.host])
    const running = (daemon as any).dispatch(AGENT_ID, msg('100', 'long question', 'T1'), 'int-a')

    try {
      await vi.waitFor(() => expect(old.host.prompt).toHaveBeenCalledTimes(1), WAIT)
      const workspace = { mode: 'from-scratch', path: join(root, 'agents', AGENT_ID, 'workspace') }
      updateAgent(root, {
        workspace: {
          ...workspace,
          additionalRepos: [
            { repoFullName: 'example-org/tools', repoId: '42', provider: 'github', materialize: 'always' }
          ]
        }
      })
      await daemon.reconcile()

      // The turn keeps its process, which no sweep takes while it runs.
      await (daemon as any).sweepIdle()
      expect(old.host.cancel).not.toHaveBeenCalled()
      expect(old.host.stop).not.toHaveBeenCalled()
      expect((daemon as any).respawnHeldEntries.size).toBe(0)

      old.release()
      await expect(running).resolves.toBe('acp-old')
      // Idle well inside the reclaim window, the process goes so the next launch writes the new checkout's `.git`.
      await (daemon as any).sweepIdle()
      await vi.waitFor(() => expect(old.host.stop).toHaveBeenCalledTimes(1), WAIT)
      expect(old.host.cancel).not.toHaveBeenCalled()
    } finally {
      old.release()
      await Promise.allSettled([running])
      await daemon.stop()
    }
  })

  it('serves a new session at once when each session has its own process', async () => {
    const old = blockingHost('old')
    const fresh = answeringHost('new')
    const root = scaffold()
    const daemon = await boot(root, [old.host, fresh.host])
    // Every session on a process of its own, as a session-isolated agent gets on a cluster.
    vi.spyOn(daemon as any, 'hostKeyFor').mockImplementation((agentId: any, key: any) => sessionHostKey(agentId, key))
    const running = (daemon as any).dispatch(AGENT_ID, msg('100', 'long question', 'T1'), 'int-a')

    try {
      await vi.waitFor(() => expect(old.host.prompt).toHaveBeenCalledTimes(1), WAIT)
      updateAgent(root, { description: 'be terse' })
      await daemon.reconcile()

      // The new session's process is not the busy one: it starts now, with the new config.
      await expect((daemon as any).dispatch(AGENT_ID, msg('200', 'second session', 'T2'), 'int-a')).resolves.toBe(
        'acp-new'
      )
      expect(old.host.cancel).not.toHaveBeenCalled()
      expect(old.host.stop).not.toHaveBeenCalled()

      old.release()
      await expect(running).resolves.toBe('acp-old')
      await vi.waitFor(() => expect(old.host.stop).toHaveBeenCalledTimes(1), WAIT)
      expect(fresh.host.stop).not.toHaveBeenCalled()
    } finally {
      old.release()
      await Promise.allSettled([running])
      await daemon.stop()
    }
  })

  it('shows a held webchat turn what it is waiting for, then runs it on the new process', async () => {
    const old = blockingHost('old')
    const fresh = answeringHost('new')
    const root = scaffold()
    const daemon = await boot(root, [old.host, fresh.host])
    const outputs: Array<{ event: unknown }> = []
    const dones: Array<{ stopReason?: string }> = []
    const sink = {
      output: (event: { event: unknown }) => outputs.push(event),
      done: (event: { stopReason?: string }) => dones.push(event)
    }
    const running = (daemon as any).dispatch(AGENT_ID, msg('100', 'long question', 'T1'), 'int-a')

    try {
      await vi.waitFor(() => expect(old.host.prompt).toHaveBeenCalledTimes(1), WAIT)
      updateAgent(root, { description: 'be terse' })
      await daemon.reconcile()
      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'console question',
        { id: 'alice', name: 'alice' },
        sink
      )
      await vi.waitFor(
        () =>
          expect(outputs.map((o) => o.event)).toContainEqual({
            kind: 'notice',
            text: '⏳ Waiting for the agent to restart…'
          }),
        WAIT
      )
      expect(fresh.host.start).not.toHaveBeenCalled()

      old.release()
      await expect(running).resolves.toBe('acp-old')
      await vi.waitFor(() => expect(dones).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]), WAIT)
      expect(fresh.prompts).toEqual([expect.stringContaining('console question')])
    } finally {
      old.release()
      await Promise.allSettled([running])
      await daemon.stop()
    }
  })

  it('releases a held turn when the agent is paused while it waits', async () => {
    const old = blockingHost('old')
    const root = scaffold()
    const daemon = await boot(root, [old.host])
    const running = (daemon as any).dispatch(AGENT_ID, msg('100', 'long question', 'T1'), 'int-a')
    let held: Promise<unknown> | undefined

    try {
      await vi.waitFor(() => expect(old.host.prompt).toHaveBeenCalledTimes(1), WAIT)
      updateAgent(root, { description: 'be terse' })
      await daemon.reconcile()
      held = (daemon as any).dispatch(AGENT_ID, msg('200', 'second session', 'T2'), 'int-a')
      await vi.waitFor(() => expect((daemon as any).respawnHeldEntries.size).toBe(1), WAIT)

      updateAgent(root, { pause: true })
      await daemon.reconcile()

      await expect(held).resolves.toBeNull()
      await expect(running).resolves.toBeNull()
      expect((daemon as any).respawnHeldEntries.size).toBe(0)
    } finally {
      old.release()
      await Promise.allSettled([running, ...(held ? [held] : [])])
      await daemon.stop()
    }
  })

  it('cuts a turn that outlives the drain window, says so, and replays it on the new process', async () => {
    const old = blockingHost('old')
    const fresh = answeringHost('new')
    const root = scaffold()
    const daemon = await boot(root, [old.host, fresh.host])
    ;(daemon as any).cfg.limits.configRespawnDrainMs = 50
    const appended = vi.spyOn((daemon as any).store, 'appendTranscript')
    const running = (daemon as any).dispatch(AGENT_ID, msg('100', 'long question', 'T1'), 'int-a')

    try {
      await vi.waitFor(() => expect(old.host.prompt).toHaveBeenCalledTimes(1), WAIT)
      updateAgent(root, { description: 'be terse' })
      await daemon.reconcile()

      await vi.waitFor(() => expect(old.host.cancel).toHaveBeenCalledWith('acp-old'), WAIT)
      expect(appended).toHaveBeenCalledWith(expect.objectContaining({ text: REPLAYED }))
      await expect(running).resolves.toBeNull()

      // The kept row runs again, on the process started with the new config.
      await vi.waitFor(() => expect(fresh.prompts).toEqual([expect.stringContaining('long question')]), WAIT)
      expect(old.host.stop).toHaveBeenCalled()
      await vi.waitFor(async () => expect(await inboxIds(root)).toEqual([]), WAIT)
    } finally {
      old.release()
      await Promise.allSettled([running])
      await daemon.stop()
    }
  })

  it('tells a webchat turn cut at the drain window to send its message again', async () => {
    const old = blockingHost('old')
    const fresh = answeringHost('new')
    const root = scaffold()
    const daemon = await boot(root, [old.host, fresh.host])
    ;(daemon as any).cfg.limits.configRespawnDrainMs = 50
    const dones: Array<{ error?: string }> = []
    const sink = { output: () => {}, done: (event: { error?: string }) => dones.push(event) }

    try {
      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'long question',
        { id: 'alice', name: 'alice' },
        sink
      )
      await vi.waitFor(() => expect(old.host.prompt).toHaveBeenCalledTimes(1), WAIT)
      updateAgent(root, { description: 'be terse' })
      await daemon.reconcile()

      // A webchat turn has no durable row, so nothing replays it.
      await vi.waitFor(() => expect(dones).toEqual([expect.objectContaining({ error: LOST })]), WAIT)
      expect(fresh.host.prompt).not.toHaveBeenCalled()
    } finally {
      old.release()
      await daemon.stop()
    }
  })

  it('holds a follow-up that becomes due while idle processes are still stopping', async () => {
    const old = blockingHost('old')
    const fresh = answeringHost('new')
    const root = scaffold()
    const daemon = await boot(root, [old.host, fresh.host])
    vi.spyOn(daemon as any, 'hostKeyFor').mockImplementation((agentId: any, key: any) => sessionHostKey(agentId, key))
    const running = (daemon as any).dispatch(AGENT_ID, msg('100', 'long question', 'T1'), 'int-a')
    let followUp: Promise<unknown> | undefined
    // An idle process of another session whose teardown takes a while.
    let finishIdleStop!: () => void
    const idleStopped = new Promise<void>((resolve) => (finishIdleStop = resolve))
    const idleKey = sessionHostKey(AGENT_ID, 'idle-session')
    const hostKeys = (daemon as any).hostKeysForAgent.bind(daemon)
    vi.spyOn(daemon as any, 'hostKeysForAgent').mockImplementation((agentId: any) => [...hostKeys(agentId), idleKey])
    const stopHostByKey = (daemon as any).stopHostByKey.bind(daemon)
    vi.spyOn(daemon as any, 'stopHostByKey').mockImplementation((key: any) =>
      key === idleKey ? idleStopped : stopHostByKey(key)
    )

    try {
      await vi.waitFor(() => expect(old.host.prompt).toHaveBeenCalledTimes(1), WAIT)
      updateAgent(root, { description: 'be terse' })
      const reconciled = daemon.reconcile()
      await vi.waitFor(() => expect((daemon as any).stopHostByKey).toHaveBeenCalledWith(idleKey), WAIT)

      // The running turn settles mid-teardown and its session's next message arrives.
      old.release()
      await expect(running).resolves.toBe('acp-old')
      followUp = (daemon as any).dispatch(AGENT_ID, msg('101', 'follow-up', 'T1'), 'int-a')
      await vi.waitFor(() => expect(fresh.prompts).toEqual([expect.stringContaining('follow-up')]), WAIT)
      expect(old.host.prompt).toHaveBeenCalledTimes(1)

      finishIdleStop()
      await reconciled
      // The session resumes its conversation, now on the process started with the new config.
      await expect(followUp).resolves.toBe('acp-old')
      expect(old.host.stop).toHaveBeenCalledTimes(1)
    } finally {
      old.release()
      finishIdleStop()
      await Promise.allSettled([running, ...(followUp ? [followUp] : [])])
      await daemon.stop()
    }
  })

  it('revokes only the grants of the retiring process, not those of a session started meanwhile', async () => {
    const old = blockingHost('old')
    const fresh = answeringHost('new')
    const root = scaffold()
    const daemon = await boot(root, [old.host, fresh.host])
    vi.spyOn(daemon as any, 'hostKeyFor').mockImplementation((agentId: any, key: any) => sessionHostKey(agentId, key))
    const FRESH_CONV = '22222222-2222-4222-8222-222222222222'
    const granted = [CONV]
    const revoked: string[] = []
    ;(daemon as any).remoteWebchatGrants = {
      conversationsForAgent: () => [...granted],
      revokeConversation: vi.fn(async (id: string) => {
        revoked.push(id)
        granted.splice(granted.indexOf(id), 1)
      }),
      revokeAll: vi.fn(async () => {})
    }
    const sink = { output: () => {}, done: () => {} }

    try {
      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'long question',
        { id: 'alice', name: 'alice' },
        sink
      )
      await vi.waitFor(() => expect(old.host.prompt).toHaveBeenCalledTimes(1), WAIT)
      updateAgent(root, { description: 'be terse' })
      await daemon.reconcile()
      expect(revoked).toEqual([])

      // Another conversation starts on a fresh process of its own and is granted access.
      granted.push(FRESH_CONV)

      old.release()
      await vi.waitFor(() => expect(old.host.stop).toHaveBeenCalledTimes(1), WAIT)
      await vi.waitFor(() => expect(revoked).toEqual([CONV]), WAIT)
      expect(granted).toEqual([FRESH_CONV])
    } finally {
      old.release()
      await daemon.stop()
    }
  })

  it('keeps a process still retiring from an earlier change out of the idle cleanup of the next one', async () => {
    const old = blockingHost('old')
    const fresh = answeringHost('new')
    const root = scaffold()
    const daemon = await boot(root, [old.host, fresh.host])
    vi.spyOn(daemon as any, 'hostKeyFor').mockImplementation((agentId: any, key: any) => sessionHostKey(agentId, key))
    const revoked: string[] = []
    ;(daemon as any).remoteWebchatGrants = {
      conversationsForAgent: () => (revoked.includes(CONV) ? [] : [CONV]),
      revokeConversation: vi.fn(async (id: string) => void revoked.push(id)),
      revokeAll: vi.fn(async () => {})
    }
    const sink = { output: () => {}, done: () => {} }

    try {
      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'long question',
        { id: 'alice', name: 'alice' },
        sink
      )
      await vi.waitFor(() => expect(old.host.prompt).toHaveBeenCalledTimes(1), WAIT)
      updateAgent(root, { description: 'be terse' })
      await daemon.reconcile()
      // A second change lands while the first is still draining the same process.
      updateAgent(root, { description: 'be brief' })
      await daemon.reconcile()
      expect(revoked).toEqual([])
      expect(old.host.stop).not.toHaveBeenCalled()
      expect(old.host.cancel).not.toHaveBeenCalled()

      old.release()
      await vi.waitFor(() => expect(old.host.stop).toHaveBeenCalledTimes(1), WAIT)
      await vi.waitFor(() => expect(revoked).toEqual([CONV]), WAIT)
    } finally {
      old.release()
      await daemon.stop()
    }
  })

  it('holds a turn for an idle process until the grant of that process is revoked', async () => {
    const busy = blockingHost('busy')
    const idle = answeringHost('idle')
    const fresh = answeringHost('new')
    const root = scaffold()
    const daemon = await boot(root, [busy.host, idle.host, fresh.host])
    vi.spyOn(daemon as any, 'hostKeyFor').mockImplementation((agentId: any, key: any) => sessionHostKey(agentId, key))
    let finishRevoke!: () => void
    const revokeDone = new Promise<void>((resolve) => (finishRevoke = resolve))
    ;(daemon as any).remoteWebchatGrants = {
      conversationsForAgent: () => [CONV],
      revokeConversation: vi.fn(() => revokeDone),
      revokeAll: vi.fn(async () => {})
    }
    const dones: Array<{ stopReason?: string }> = []
    const sink = { output: () => {}, done: (event: { stopReason?: string }) => dones.push(event) }
    const running = (daemon as any).dispatch(AGENT_ID, msg('100', 'long question', 'T1'), 'int-a')

    try {
      await vi.waitFor(() => expect(busy.host.prompt).toHaveBeenCalledTimes(1), WAIT)
      // An earlier conversation, answered and idle on a process of its own.
      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'first',
        { id: 'alice', name: 'alice' },
        sink
      )
      await vi.waitFor(() => expect(dones).toHaveLength(1), WAIT)

      updateAgent(root, { description: 'be terse' })
      const reconciled = daemon.reconcile()
      await vi.waitFor(() => expect(idle.host.stop).toHaveBeenCalledTimes(1), WAIT)
      await vi.waitFor(() => expect((daemon as any).remoteWebchatGrants.revokeConversation).toHaveBeenCalled(), WAIT)

      // Its next message must not start before the old grant is gone.
      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'second',
        { id: 'alice', name: 'alice' },
        sink
      )
      await vi.waitFor(() => expect((daemon as any).respawnHeldEntries.size).toBe(1), WAIT)
      expect(fresh.host.prompt).not.toHaveBeenCalled()

      finishRevoke()
      await reconciled
      await vi.waitFor(() => expect(fresh.prompts).toEqual([expect.stringContaining('second')]), WAIT)
      expect(busy.host.cancel).not.toHaveBeenCalled()
    } finally {
      finishRevoke()
      busy.release()
      await Promise.allSettled([running])
      await daemon.stop()
    }
  })

  it('keeps holding a model session turn while its released pool entry is still stopping', async () => {
    const old = blockingHost('old')
    const root = scaffold()
    const daemon = await boot(root, [old.host])
    const convKey = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
    // A key-server model session: its pool entry is gone as soon as release starts, before the stop finishes.
    let pooled = false
    let finishRelease!: () => void
    const released = new Promise<void>((resolve) => (finishRelease = resolve))
    const pool = (daemon as any).modelSessions
    vi.spyOn(pool, 'has').mockImplementation((key: any) => pooled && key === convKey)
    vi.spyOn(pool, 'releaseForAgent').mockResolvedValue(undefined)
    vi.spyOn(pool, 'release').mockImplementation(() => {
      pooled = false
      return released
    })
    const dones: Array<{ stopReason?: string }> = []
    const sink = { output: () => {}, done: (event: { stopReason?: string }) => dones.push(event) }

    try {
      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'long question',
        { id: 'alice', name: 'alice' },
        sink
      )
      await vi.waitFor(() => expect(old.host.prompt).toHaveBeenCalledTimes(1), WAIT)
      pooled = true
      updateAgent(root, { description: 'be terse' })
      await daemon.reconcile()

      old.release()
      await vi.waitFor(() => expect(pool.release).toHaveBeenCalledWith(convKey), WAIT)
      // The owner lookup no longer names the model session, yet the next message still waits for it.
      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'second',
        { id: 'alice', name: 'alice' },
        sink
      )
      await vi.waitFor(() => expect((daemon as any).respawnHeldEntries.size).toBe(1), WAIT)
      expect(old.host.prompt).toHaveBeenCalledTimes(1)

      finishRelease()
      await vi.waitFor(() => expect((daemon as any).respawnHeldEntries.size).toBe(0), WAIT)
    } finally {
      old.release()
      finishRelease()
      await daemon.stop()
    }
  })

  it('tells a turn cut while still starting up that it will be picked up again, and replays it', async () => {
    const stuck = stuckStartHost()
    const fresh = answeringHost('new')
    const root = scaffold()
    const daemon = await boot(root, [stuck, fresh.host])
    ;(daemon as any).cfg.limits.cancelBackstopMs = 20
    const appended = vi.spyOn((daemon as any).store, 'appendTranscript')
    const starting = (daemon as any).dispatch(AGENT_ID, msg('100', 'early question', 'T1'), 'int-a')
    void starting.catch(() => {})

    try {
      await vi.waitFor(() => expect(stuck.newSession).toHaveBeenCalledTimes(1), WAIT)
      updateAgent(root, { description: 'be terse' })
      await daemon.reconcile()

      expect(appended).toHaveBeenCalledWith(expect.objectContaining({ text: REPLAYED }))
      await vi.waitFor(() => expect(fresh.prompts).toEqual([expect.stringContaining('early question')]), WAIT)
      await vi.waitFor(async () => expect(await inboxIds(root)).toEqual([]), WAIT)
    } finally {
      await daemon.stop()
    }
  })

  it('tells a webchat turn cut while still starting up to send its message again', async () => {
    const stuck = stuckStartHost()
    const fresh = answeringHost('new')
    const root = scaffold()
    const daemon = await boot(root, [stuck, fresh.host])
    ;(daemon as any).cfg.limits.cancelBackstopMs = 20
    const dones: Array<{ error?: string }> = []
    const sink = { output: () => {}, done: (event: { error?: string }) => dones.push(event) }

    try {
      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'early question',
        { id: 'alice', name: 'alice' },
        sink
      )
      await vi.waitFor(() => expect(stuck.newSession).toHaveBeenCalledTimes(1), WAIT)
      updateAgent(root, { description: 'be terse' })
      await daemon.reconcile()

      await vi.waitFor(() => expect(dones).toEqual([expect.objectContaining({ error: LOST })]), WAIT)
      expect(fresh.host.prompt).not.toHaveBeenCalled()
    } finally {
      await daemon.stop()
    }
  })

  it('tells a turn cut by the shutdown drain that it will be picked up again', async () => {
    const old = blockingHost('old')
    const root = scaffold()
    const daemon = await boot(root, [old.host])
    ;(daemon as any).cfg.limits.shutdownDrainMs = 0
    const appended = vi.spyOn((daemon as any).store, 'appendTranscript')
    const running = (daemon as any).dispatch(AGENT_ID, msg('100', 'long question', 'T1'), 'int-a')
    void running.catch(() => {})

    await vi.waitFor(() => expect(old.host.prompt).toHaveBeenCalledTimes(1), WAIT)
    await daemon.stop()

    expect(appended).toHaveBeenCalledWith(
      expect.objectContaining({ text: '⚠️ The agent is restarting — this message will be picked up again.' })
    )
    expect(await inboxIds(root)).toEqual(['slack:C1:100'])
  })
})
