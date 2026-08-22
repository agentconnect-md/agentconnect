import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import type { WebchatOutput, WebchatDone } from '@agentconnect.md/protocol'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

// vi.waitFor defaults to a 1000ms budget — too tight on a loaded CI runner, where a
// cold session boot (workspace + host + session/new) can stall well past a second.
// Give every poll in this file the same generous budget instead.
const WAIT = { timeout: 10_000 }

/**
 * P4-gate: the per-sessionKey serial admission gate (design §4.3/§6.9). These drive
 * `dispatch` directly with a blocking ACP host so we can freeze a turn mid-prompt and
 * assert the gate's behavior: atomic ownership, FIFO drain (incl. the release-window race),
 * per-entry promise settlement, fail-stop, and the queue-depth cap.
 */

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-gate-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      // This suite pins the base serial-gate contract (one turn per queued
      // activation); the coalescing on-path is covered by turn-output-workflow.
      features: { turnFinalContextRefresh: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'low' }
    })
  )
  return root
}

/**
 * A host whose N-th prompt is gated: `gate(n)` resolves a deferred that lets prompt #n
 * return, and `failNext(n)` makes prompt #n reject. Records how many prompts have STARTED
 * (so we can assert the second concurrent dispatch never enters prompt while the first is
 * still blocked) and the block texts in call order.
 */
function gatedHost() {
  const releases: Array<() => void> = []
  const started: string[] = []
  let calls = 0
  const failAt = new Set<number>()
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async (_sid: string, blocks: { text?: string }[]) => {
      const n = ++calls
      started.push(blocks.map((b) => b.text ?? '').join('|'))
      await new Promise<void>((r) => releases.push(r))
      if (failAt.has(n)) throw new Error(`boom-${n}`)
      return 'end_turn'
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
  return {
    host,
    started,
    /** Release the oldest still-blocked prompt (FIFO of blocked prompts). */
    releaseOne: () => releases.shift()?.(),
    releaseAll: () => {
      while (releases.length) releases.shift()!()
    },
    failNext: (n: number) => failAt.add(n),
    blockedCount: () => releases.length
  }
}

const msg = (ts: string, text: string, thread = 'T1') => ({
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

async function boot(host: any) {
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root: scaffold(),
    hostFactory: () => host as any
  })
  await daemon.start()
  return daemon
}

const seam = (d: Daemon) => (d as any).cpConfigApply()

describe('P4 serial gate', () => {
  it('two concurrent dispatch for the same sessionKey: the second is queued, does not enter handle() concurrently, does not overwrite pending', async () => {
    const g = gatedHost()
    const daemon = await boot(g.host)
    const key = 'slack:C1:T1:bot-a'

    // Fire both in the SAME tick (cold session: no ACP id yet) before any await.
    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    const p2 = (daemon as any).dispatch('bot-a', msg('200', 'second'), 'int-a')

    // The first claims ownership and starts its prompt; the second is queued behind it.
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    expect((daemon as any).inflight.has(key)).toBe(true)
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1), WAIT)
    // Only ONE pending entry for the single live ACP session — no concurrent overwrite.
    expect((daemon as any).pending.size).toBe(1)
    expect(g.started[0]).toContain('first')
    // Give the event loop turns: the second prompt must NOT have started.
    await new Promise((r) => setTimeout(r, 20))
    expect(g.started.length).toBe(1)

    // Release the head → the queued second now runs, in order.
    g.releaseOne()
    await p1
    await vi.waitFor(() => expect(g.started.length).toBe(2), WAIT)
    expect(g.started[1]).toContain('second')
    g.releaseOne()
    await p2
    // Queue drained, ownership released.
    expect((daemon as any).inflight.has(key)).toBe(false)
    expect((daemon as any).serialQueue.has(key)).toBe(false)

    await daemon.stop()
  }, 15_000)

  it('keeps the active turn and queued follow-up alive across an App-backed repository rename', async () => {
    const root = scaffold()
    const workspace = join(root, 'agents', 'bot-a', 'workspace')
    mkdirSync(workspace, { recursive: true })
    execFileSync('git', ['init', workspace], { stdio: 'ignore' })
    execFileSync('git', ['-C', workspace, 'remote', 'add', 'origin', 'https://github.com/acme/old-name'])
    writeFileSync(
      join(root, 'agents', 'bot-a', 'agent.json'),
      JSON.stringify({
        id: 'bot-a',
        name: 'bot-a',
        status: 'active',
        runtime: 'claude',
        workspace: {
          mode: 'git-repo',
          path: workspace,
          gitRepo: 'https://github.com/acme/old-name',
          gitBranch: 'main',
          gitCredential: 'github-app',
          pullOnNewSession: false
        },
        integrations: [],
        output: { mode: 'low' }
      })
    )

    const g = gatedHost()
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => g.host as any })
    await daemon.start()
    const key = 'slack:C1:T1:bot-a'
    const active = (daemon as any).dispatch('bot-a', msg('100', 'active'), 'int-a')
    await vi.waitFor(() => expect(g.started).toHaveLength(1), WAIT)
    const queued = (daemon as any).dispatch('bot-a', msg('200', 'queued'), 'int-a')
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1), WAIT)

    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: {
        name: 'bot-a',
        workspace: {
          mode: 'github',
          gitRepo: 'https://github.com/acme/new-name',
          branch: 'main',
          gitCredential: 'github-app'
        }
      }
    })

    expect(g.host.cancel).not.toHaveBeenCalled()
    expect(g.host.stop).not.toHaveBeenCalled()
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1), WAIT)
    expect(execFileSync('git', ['-C', workspace, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()).toBe(
      'https://github.com/acme/new-name'
    )

    g.releaseOne()
    await expect(active).resolves.toBe('acp-1')
    await vi.waitFor(() => expect(g.started).toHaveLength(2), WAIT)
    expect(g.started[1]).toContain('queued')
    g.releaseOne()
    await expect(queued).resolves.toBe('acp-1')
    await daemon.stop()
  }, 15_000)

  it('evicts a cached host when App-backed rename convergence fails closed', async () => {
    const root = scaffold()
    const workspace = join(root, 'agents', 'bot-a', 'workspace')
    mkdirSync(workspace, { recursive: true })
    execFileSync('git', ['init', workspace], { stdio: 'ignore' })
    execFileSync('git', ['-C', workspace, 'remote', 'add', 'origin', 'https://github.com/acme/old-name'])
    writeFileSync(
      join(root, 'agents', 'bot-a', 'agent.json'),
      JSON.stringify({
        id: 'bot-a',
        name: 'bot-a',
        status: 'active',
        runtime: 'claude',
        workspace: {
          mode: 'git-repo',
          path: workspace,
          gitRepo: 'https://github.com/acme/old-name',
          gitBranch: 'main',
          gitCredential: 'github-app',
          pullOnNewSession: false
        },
        integrations: [],
        output: { mode: 'low' }
      })
    )

    const g = gatedHost()
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => g.host as any })
    await daemon.start()
    await (daemon as any).ensureHostAsync('bot-a')
    expect((daemon as any).hosts.has('bot-a')).toBe(true)

    // Simulate a historical checkout whose actual origin does not match the
    // App-authorized GitHub repository, then deliver a canonical rename update.
    execFileSync('git', ['-C', workspace, 'remote', 'set-url', 'origin', 'https://other-host.example/acme/old-name'])
    await seam(daemon).applyAgentUpsert({
      agentId: 'bot-a',
      spec: {
        name: 'bot-a',
        workspace: {
          mode: 'github',
          gitRepo: 'https://github.com/acme/new-name',
          branch: 'main',
          gitCredential: 'github-app'
        }
      }
    })

    expect(g.host.stop).toHaveBeenCalledTimes(1)
    expect((daemon as any).hosts.has('bot-a')).toBe(false)
    await daemon.stop()
  }, 15_000)

  it('uses a stale Slack event only as a wake-up and suppresses later delivery of messages already covered by the snapshot watermark', async () => {
    const g = gatedHost()
    const daemon = await boot(g.host)

    // Establish the warm session at the root message.
    const root = (daemon as any).dispatch('bot-a', msg('100.1', 'root request', '100.1'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    g.releaseOne()
    await root

    // Slack already has B/C/D, but Socket Mode wakes us with only the stale B event.
    ;(daemon as any).sessions.deps.fetchThreadHistory = vi.fn(async () => [
      { sender: 'U1', ts: '100.2', text: 'B stale trigger' },
      { sender: 'U1', ts: '100.3', text: 'C newer clarification' },
      { sender: 'U1', ts: '100.4', text: 'D latest: merge it' }
    ])
    const staleWake = (daemon as any).dispatch('bot-a', msg('100.2', 'B stale trigger', '100.1'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(2), WAIT)
    expect(g.started[1]).toContain('B stale trigger')
    expect(g.started[1]).toContain('C newer clarification')
    expect(g.started[1]).toContain('D latest: merge it')
    expect(g.started[1]!.indexOf('B stale trigger')).toBeLessThan(g.started[1]!.indexOf('D latest: merge it'))
    g.releaseOne()
    await staleWake

    // C then arrives late over Socket Mode. Its ts is already behind the watermark,
    // so dispatch settles as a no-op and the model is not prompted a third time.
    await expect(
      (daemon as any).dispatch('bot-a', msg('100.3', 'C newer clarification', '100.1'), 'int-a')
    ).resolves.toBeNull()
    await new Promise((r) => setTimeout(r, 20))
    expect(g.started).toHaveLength(2)

    await daemon.stop()
  }, 15_000)

  it('FIFO under concurrent arrival: a message arriving between a turn finishing and inflight release still lands after the already-queued head', async () => {
    const g = gatedHost()
    const daemon = await boot(g.host)
    const key = 'slack:C1:T1:bot-a'

    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    // Queue the head-of-line follow-up while the first turn runs.
    const p2 = (daemon as any).dispatch('bot-a', msg('200', 'queued-head'), 'int-a')
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1), WAIT)

    // Now release the first turn. runLoop keeps ownership and picks up 'queued-head'
    // WITHOUT releasing inflight — a racing arrival can't jump ahead of it.
    g.releaseOne()
    await p1
    // 'queued-head' is now the running turn; inject a NEW arrival in this window.
    await vi.waitFor(() => expect(g.started.length).toBe(2), WAIT)
    expect(g.started[1]).toContain('queued-head')
    const p3 = (daemon as any).dispatch('bot-a', msg('300', 'late-arrival'), 'int-a')
    // It is queued behind the running head (ownership was never released) — FIFO holds.
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1), WAIT)

    g.releaseOne() // finish queued-head
    await p2
    await vi.waitFor(() => expect(g.started.length).toBe(3), WAIT)
    expect(g.started[2]).toContain('late-arrival')
    g.releaseOne()
    await p3
    expect((daemon as any).inflight.has(key)).toBe(false)

    await daemon.stop()
  }, 15_000)

  it('a follower stalled before placement reclaims a gate the owner released meanwhile', async () => {
    const g = gatedHost()
    const daemon = await boot(g.host)
    const key = 'slack:C1:T1:bot-a'

    // Freeze the FOLLOWER's durable write: its placement then lands after the owner has
    // already drained, seen an empty queue and given the claim back (the strand window).
    const persistInbox = (daemon as any).persistInbox.bind(daemon)
    let resumeWrite!: () => void
    const writeGate = new Promise<void>((r) => (resumeWrite = r))
    let writes = 0
    ;(daemon as any).persistInbox = async (...args: any[]) => {
      if (++writes === 2) await writeGate
      return persistInbox(...args)
    }

    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    const p2 = (daemon as any).dispatch('bot-a', msg('200', 'second'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    await vi.waitFor(() => expect(writes).toBe(2), WAIT)
    // The follower is still mid-write, so it has published nothing to queue behind.
    expect((daemon as any).serialQueue.get(key) ?? []).toHaveLength(0)

    // Finish the owner's turn: the queue reads empty, so the claim is released.
    g.releaseOne()
    await p1
    await vi.waitFor(() => expect((daemon as any).inflight.has(key)).toBe(false), WAIT)

    // Resuming the write publishes the entry under no claim holder — it must reclaim the
    // gate and run itself instead of sitting in the queue with its promise pending forever.
    resumeWrite()
    await vi.waitFor(() => expect(g.started.length).toBe(2), WAIT)
    expect(g.started[1]).toContain('second')
    g.releaseOne()
    await p2
    expect((daemon as any).inflight.has(key)).toBe(false)
    expect((daemon as any).serialQueue.has(key)).toBe(false)

    await daemon.stop()
  }, 15_000)

  it('two followers keep arrival order when the earlier one stalls in its durable write', async () => {
    const g = gatedHost()
    const daemon = await boot(g.host)
    const key = 'slack:C1:T1:bot-a'

    // Stall the FIRST follower's durable write. A later arrival must not overtake it just
    // because its own write finished sooner — the gate is arrival-order FIFO (§4.1-4.3).
    const persistInbox = (daemon as any).persistInbox.bind(daemon)
    let resumeWrite!: () => void
    const writeGate = new Promise<void>((r) => (resumeWrite = r))
    let writes = 0
    ;(daemon as any).persistInbox = async (...args: any[]) => {
      if (++writes === 2) await writeGate
      return persistInbox(...args)
    }

    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    const p2 = (daemon as any).dispatch('bot-a', msg('200', 'second'), 'int-a')
    await vi.waitFor(() => expect(writes).toBe(2), WAIT)
    const p3 = (daemon as any).dispatch('bot-a', msg('300', 'third'), 'int-a')

    // 'third' persists fast, but its admission is chained behind the stalled 'second', so it
    // can neither place first nor slip past the depth accounting.
    await new Promise((r) => setTimeout(r, 30))
    expect((daemon as any).serialQueue.get(key) ?? []).toHaveLength(0)

    resumeWrite()
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(2), WAIT)
    g.releaseOne()
    await p1
    await vi.waitFor(() => expect(g.started.length).toBe(2), WAIT)
    expect(g.started[1]).toContain('second')
    g.releaseOne()
    await p2
    await vi.waitFor(() => expect(g.started.length).toBe(3), WAIT)
    expect(g.started[2]).toContain('third')
    g.releaseOne()
    await p3
    expect((daemon as any).inflight.has(key)).toBe(false)

    await daemon.stop()
  }, 15_000)

  it('a fresh arrival cannot claim an idle gate ahead of an admission still in flight', async () => {
    const g = gatedHost()
    const daemon = await boot(g.host)
    const key = 'slack:C1:T1:bot-a'

    const persistInbox = (daemon as any).persistInbox.bind(daemon)
    let resumeWrite!: () => void
    const writeGate = new Promise<void>((r) => (resumeWrite = r))
    let writes = 0
    ;(daemon as any).persistInbox = async (...args: any[]) => {
      if (++writes === 2) await writeGate
      return persistInbox(...args)
    }

    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    const p2 = (daemon as any).dispatch('bot-a', msg('200', 'second'), 'int-a')
    await vi.waitFor(() => expect(writes).toBe(2), WAIT)

    // The owner drains and gives the gate back while 'second' is still persisting.
    g.releaseOne()
    await p1
    await vi.waitFor(() => expect((daemon as any).inflight.has(key)).toBe(false), WAIT)

    // 'third' now finds the gate idle. It must NOT take the direct claim: an older arrival
    // still holds an admission reservation, and starting here would overtake it.
    const p3 = (daemon as any).dispatch('bot-a', msg('300', 'third'), 'int-a')
    await new Promise((r) => setTimeout(r, 30))
    expect(g.started.length).toBe(1)

    resumeWrite()
    await vi.waitFor(() => expect(g.started.length).toBe(2), WAIT)
    expect(g.started[1]).toContain('second')
    g.releaseOne()
    await p2
    await vi.waitFor(() => expect(g.started.length).toBe(3), WAIT)
    expect(g.started[2]).toContain('third')
    g.releaseOne()
    await p3
    expect((daemon as any).inflight.has(key)).toBe(false)
    expect((daemon as any).dispatchAdmissionChains.has(key)).toBe(false)

    await daemon.stop()
  }, 15_000)

  it("a queued message's own dispatch() promise resolves with its sessionId / rejects with its own error (contract preserved)", async () => {
    const g = gatedHost()
    const daemon = await boot(g.host)

    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    const p2 = (daemon as any).dispatch('bot-a', msg('200', 'second'), 'int-a')

    // Head resolves with ITS sessionId; the queued entry resolves with its own (same
    // session here, but its OWN promise — settled when ITS turn ran, not the head's).
    g.releaseOne()
    await expect(p1).resolves.toBe('acp-1')
    await vi.waitFor(() => expect(g.started.length).toBe(2), WAIT)
    // p2 is still pending until its own turn completes.
    let p2Settled = false
    void p2.then(() => (p2Settled = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(p2Settled).toBe(false)
    g.releaseOne()
    await expect(p2).resolves.toBe('acp-1')

    await daemon.stop()
  }, 15_000)

  it('fail-stop: a failing turn does NOT auto-run the queued rest — each is rejected with its own error', async () => {
    const g = gatedHost()
    g.failNext(1) // the head turn's prompt rejects
    const daemon = await boot(g.host)
    const key = 'slack:C1:T1:bot-a'

    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    const p2 = (daemon as any).dispatch('bot-a', msg('200', 'second'), 'int-a')
    const p3 = (daemon as any).dispatch('bot-a', msg('300', 'third'), 'int-a')
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(2), WAIT)

    // Release the head → its prompt throws. Fail-stop: the queue is NOT drained.
    g.releaseOne()
    await expect(p1).rejects.toThrow('boom-1')
    await expect(p2).rejects.toThrow(/fail_stop|not auto-run/)
    await expect(p3).rejects.toThrow(/fail_stop|not auto-run/)
    // No further prompts started; ownership released; queue cleared.
    await new Promise((r) => setTimeout(r, 20))
    expect(g.started.length).toBe(1)
    expect((daemon as any).inflight.has(key)).toBe(false)
    expect((daemon as any).serialQueue.has(key)).toBe(false)

    await daemon.stop()
  }, 15_000)

  it('queue_full fast-fail at the depth cap (backpressure §4.4)', async () => {
    const g = gatedHost()
    const daemon = await boot(g.host)
    const key = 'slack:C1:T1:bot-a'

    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)

    // Fill the queue to the cap (10), then the 11th is rejected fast without buffering.
    const queued: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++)
      queued.push((daemon as any).dispatch('bot-a', msg(`${200 + i}`, `m${i}`), 'int-a').catch(() => 'rej'))
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(10), WAIT)

    const overflow = (daemon as any).dispatch('bot-a', msg('999', 'overflow'), 'int-a')
    await expect(overflow).rejects.toThrow(/queue_full|queue full/)
    // Still exactly 10 — the rejected message was never admitted.
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(10), WAIT)

    // Drain everything so the daemon can stop cleanly. Each queued turn only
    // creates its gate after the previous turn settles, so the retry loop
    // releases them one per tick — 10 serial turns overflow waitFor's default
    // 1s budget on a loaded CI runner (recurring flake).
    g.releaseAll()
    await p1
    await vi.waitFor(
      async () => {
        g.releaseAll()
        expect((daemon as any).inflight.has(key)).toBe(false)
      },
      { timeout: 10_000, interval: 25 }
    )
    await Promise.all(queued)

    await daemon.stop()
  }, 15_000)

  it('a queued entry is settled (not dropped) at shutdown', async () => {
    const g = gatedHost()
    const daemon = await boot(g.host)
    const key = 'slack:C1:T1:bot-a'

    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    const p2 = (daemon as any).dispatch('bot-a', msg('200', 'second'), 'int-a')
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1), WAIT)

    // Shut down while the head is still blocked. The queued entry must SETTLE (be it a
    // gate-drop null once the head drains, or an explicit reject) rather than leave an
    // unsettled promise hanging forever.
    let settled = false
    void p2.then(
      () => (settled = true),
      () => (settled = true)
    )
    g.releaseAll() // let the head's prompt return so drain doesn't hang the whole timeout
    const stop = daemon.stop()
    await p1.catch(() => {})
    await stop
    // Wait for the settlement itself. A fixed ten milliseconds was a bet that the drop landed
    // within them, and the assertion is positive, so a slow runner failed it outright.
    await vi.waitFor(() => expect(settled).toBe(true), WAIT)
    expect((daemon as any).serialQueue.has(key)).toBe(false)
  }, 15_000)

  // A webchat turn signals its client via the WebchatSink terminal `done` frame, NOT the
  // dispatch() promise. So when a QUEUED webchat entry is gate-dropped/rejected without ever
  // running, settling its promise alone leaves the browser UI spinning forever — the queued
  // entry's sink MUST also get a terminal done frame. (regression: P4-gate serial-gate paths)
  const makeSink = () => {
    const dones: WebchatDone[] = []
    return {
      dones,
      sink: { output: (_o: WebchatOutput) => {}, done: (d: WebchatDone) => dones.push(d) }
    }
  }

  it('gate-drop (pause) terminates a QUEUED webchat entry’s sink with a done frame', async () => {
    const g = gatedHost()
    const daemon = await boot(g.host)
    const key = 'slack:C1:T1:bot-a'
    const cp = makeSink()
    const turnId = '77777777-7777-4777-8777-777777777777'

    // Head turn (non-webchat) blocks in prompt; a WEBCHAT turn queues behind it.
    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    const p2 = (daemon as any).dispatch('bot-a', msg('200', 'second'), 'int-a', {
      conversationId: 'conv-a',
      turnId,
      sink: cp.sink
    })
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1), WAIT)

    // Pause the agent, then release the head. runLoop's pre-turn re-check gate-drops the
    // queued webchat entry (resolve(null)) — and must terminate its sink.
    ;(daemon as any).agents.get('bot-a').pause = true
    g.releaseOne()
    await expect(p1).resolves.toBe('acp-1')
    await expect(p2).resolves.toBeNull()

    // The queued webchat entry got a terminal done frame (clean drop → no error) so the
    // browser stops spinning instead of hanging.
    expect(cp.dones).toEqual([{ conversationId: 'conv-a', turnId }])

    await daemon.stop()
  }, 15_000)

  it('shutdown terminates a QUEUED webchat entry’s sink with an error done frame', async () => {
    const g = gatedHost()
    const daemon = await boot(g.host)
    const key = 'slack:C1:T1:bot-a'
    const cp = makeSink()
    const turnId = '99999999-9999-4999-8999-999999999999'

    const p1 = (daemon as any).dispatch('bot-a', msg('100', 'first'), 'int-a')
    await vi.waitFor(() => expect(g.started.length).toBe(1), WAIT)
    const p2 = (daemon as any).dispatch('bot-a', msg('200', 'second'), 'int-a', {
      conversationId: 'conv-b',
      turnId,
      sink: cp.sink
    })
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1), WAIT)

    // Drive settleQueuedForShutdown directly so the queued (never-run) webchat entry is
    // rejected — its sink must still get a terminal done frame carrying an error.
    void p2.catch(() => {})
    ;(daemon as any).settleQueuedForShutdown()
    await new Promise((r) => setTimeout(r, 10))

    expect(cp.dones).toHaveLength(1)
    expect(cp.dones[0]).toMatchObject({ conversationId: 'conv-b', turnId })
    expect(cp.dones[0]!.error).toBeTruthy()

    // Let the still-blocked head drain so the daemon can stop cleanly.
    g.releaseAll()
    await p1.catch(() => {})
    await daemon.stop()
  }, 15_000)
})
