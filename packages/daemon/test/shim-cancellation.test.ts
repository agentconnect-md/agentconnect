import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Backoff, ClientTransport, FakeClock } from '@agentconnect.md/connection'
import { ShimListener, type ShimConnection } from '../src/shim/listener.js'
import { ShimClient, type ShimTransport } from '../src/shim/client.js'
import { ShimChannel, ShimRequestAbortedError } from '../src/shim/channels.js'
import { createExecHandler } from '../src/shim/exec-handler.js'
import { ShimGitRunner } from '../src/shim/git-exec.js'
import type { ShimFrame } from '../src/shim/protocol.js'
import type { SpawnRecord } from '../src/shim/binding.js'

// Cancellation across the channel, end to end: real socket, real shim client, real hanging git.
// The point is not that the daemon's promise rejects — a bare timeout already did that — but that
// the CHILD DIES. An abandoned git keeps index.lock and wedges the next session's pull, which is
// exactly what simple-git's signal handling prevents on the local runner.

const listeners: ShimListener[] = []
const clients: ShimClient[] = []
const roots: string[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop()
  await Promise.all(listeners.splice(0).map((instance) => instance.stop()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const timers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout)
}

/**
 * A repository whose `config` read blocks forever: git waits on a FIFO with no writer.
 *
 * `marker` goes in the ARGV, not the env, because the env is how the hang is arranged but not
 * something `pgrep -f` can see — a first version keyed the process search on the FIFO path and
 * therefore never found the child, so one test passed while observing nothing at all.
 */
function blockingRepository(): { root: string; env: Record<string, string>; marker: string } {
  const root = mkdtempSync(join(tmpdir(), 'ac-cancel-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root })
  writeFileSync(join(root, 'a.txt'), 'a\n')
  execFileSync('git', ['add', 'a.txt'], { cwd: root })
  const fifo = join(root, 'blocking.gitconfig')
  execFileSync('mkfifo', [fifo])
  return {
    root,
    env: { PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_GLOBAL: fifo },
    marker: `acmarker${randomUUID().replace(/-/g, '')}`
  }
}

/** Real listener + real shim client, the client serving git through the production handler. */
async function channelUnderTest(
  workspaceRoot: string
): Promise<{ channel: ShimChannel; connection: ShimConnection; sent: ShimFrame[] }> {
  const record: SpawnRecord = {
    agentId: 'agent-a',
    generation: 1,
    podName: 'runtime-1',
    podUid: 'pod-uid-1',
    grants: ['exec', 'materialize']
  } as SpawnRecord
  const listener = new ShimListener({
    verifier: { reviewToken: async () => ({ authenticated: true, podName: 'runtime-1', podUid: 'pod-uid-1' }) },
    spawnRecordForPod: () => record,
    now: () => Date.now(),
    log: { info: () => {}, warn: () => {} }
  })
  listeners.push(listener)
  const port = await listener.start(0, '127.0.0.1')

  const client = new ShimClient({
    endpoint: `ws://127.0.0.1:${port}`,
    dial: (url, opts) =>
      ClientTransport.dial(url, { subprotocol: opts.subprotocol, path: opts.path }) as Promise<ShimTransport>,
    readToken: () => 'projected-token',
    clock: new FakeClock(),
    backoff: new Backoff({ jitter: () => 0 }),
    handle: createExecHandler({ workspaceRoot, log: { info: () => {}, warn: () => {} } }),
    log: { info: () => {}, warn: () => {} }
  })
  clients.push(client)
  void client.start()

  const deadline = Date.now() + 5_000
  for (;;) {
    const connection = listener.connectionsFor('agent-a')[0]
    if (connection) {
      // Observed so a test can read the REAL request id. Sending a cancel for an invented id
      // proves nothing — the lookup misses whether or not the fencing is there, which is how the
      // first version of the stale-generation test below passed against unfenced code.
      const sent: ShimFrame[] = []
      const observed: ShimConnection = {
        binding: connection.binding,
        issuedCredential: connection.issuedCredential,
        send: (frame) => {
          sent.push(frame)
          connection.send(frame)
        },
        onFrame: (listen) => connection.onFrame(listen),
        close: (reason) => connection.close(reason)
      }
      return { channel: new ShimChannel(observed, connection.issuedCredential, timers), connection: observed, sent }
    }
    if (Date.now() > deadline) throw new Error('no channel bound in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Git children still alive, found by the marker this test put in their argv. */
function liveGitChildren(marker: string): number {
  try {
    return Number(execFileSync('pgrep', ['-fc', marker], { encoding: 'utf8' }).trim()) || 0
  } catch {
    // pgrep exits non-zero when nothing matches.
    return 0
  }
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

describe('shim request cancellation', () => {
  it('kills the git running INSIDE the sandbox when the daemon aborts', async () => {
    const { root, env, marker } = blockingRepository()
    const { channel } = await channelUnderTest(root)
    const abort = new AbortController()
    const runner = new ShimGitRunner(channel, root, undefined, abort.signal).withEnv(env)

    const inflight = runner.raw(['config', '--get', `user.${marker}`])
    // Abort only once the child is really running, otherwise the test proves nothing about
    // killing it — an earlier version of this workstream shipped exactly that mistake.
    expect(await until(() => liveGitChildren(marker) > 0)).toBe(true)

    abort.abort()
    await expect(inflight).rejects.toBeInstanceOf(ShimRequestAbortedError)
    // The actual claim: the child is gone. Rejecting the promise while git keeps running is the
    // failure this exists to prevent, and it looks identical from the caller's side.
    expect(await until(() => liveGitChildren(marker) === 0)).toBe(true)
  })

  it('refuses a cancel carrying a stale generation, leaving the work running', async () => {
    const { root, env, marker } = blockingRepository()
    const { channel, connection, sent } = await channelUnderTest(root)
    const runner = new ShimGitRunner(channel, root, undefined).withEnv(env)
    const inflight = runner.raw(['config', '--get', `user.${marker}`]).catch(() => 'failed')
    expect(await until(() => liveGitChildren(marker) > 0)).toBe(true)

    // The cancel targets the request that is ACTUALLY in flight, and differs from a valid one
    // only in its generation — so the child surviving can only be the fencing.
    const request = sent.find((frame) => frame.type === 'shim/request')
    expect(request?.type).toBe('shim/request')
    connection.send({
      type: 'shim/cancel',
      id: (request as Extract<ShimFrame, { type: 'shim/request' }>).id,
      sessionCredential: connection.issuedCredential,
      generation: connection.binding.generation + 5,
      reason: 'stale'
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(liveGitChildren(marker)).toBeGreaterThan(0)
    void inflight
  })

  it('cancels in the sandbox when the request times out, not just locally', async () => {
    const { root, env, marker } = blockingRepository()
    const { channel } = await channelUnderTest(root)
    const inflight = channel
      .request('exec', { tool: 'git', args: ['config', '--get', `user.${marker}`], env }, { timeoutMs: 1_500 })
      .then(() => 'resolved')
      .catch((err: Error) => err.message)
    // Prove the child got as far as running, so the assertion below is about it being killed.
    expect(await until(() => liveGitChildren(marker) > 0)).toBe(true)
    expect(await inflight).toMatch(/timed out/)
    // A timeout that only gives up locally leaves the child holding whatever it holds.
    expect(await until(() => liveGitChildren(marker) === 0)).toBe(true)
  })
})
