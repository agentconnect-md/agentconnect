import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Backoff, FakeClock } from '@agentconnect.md/connection'
import type { ShimConnection } from '../src/shim/connection.js'
import { ShimChannel, ShimRequestAbortedError } from '../src/shim/channels.js'
import { createExecHandler } from '../src/shim/exec-handler.js'
import { ShimGitRunner } from '../src/shim/git-exec.js'
import type { ShimFrame } from '../src/shim/protocol.js'
import type { SpawnRecord } from '../src/shim/binding.js'
import { shimFixtures } from './fakes/shim-sandbox.js'

// Cancellation across the channel, end to end: real socket, real shim client, real hanging git.
// The point is not that the daemon's promise rejects — a bare timeout already did that — but that
// the CHILD DIES. An abandoned git keeps index.lock and wedges the next session's pull, which is
// exactly what simple-git's signal handling prevents on the local runner.

const fixtures = shimFixtures()
const roots: string[] = []

afterEach(async () => {
  await fixtures.cleanup()
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

/** Real dialer + real shim server, the in-pod client serving git through the production handler. */
async function channelUnderTest(
  workspaceRoot: string,
  options: { credentialTtlMs?: number; shimClock?: FakeClock } = {}
): Promise<{ channel: ShimChannel; connection: ShimConnection; sent: ShimFrame[] }> {
  const record: SpawnRecord = {
    agentId: 'agent-a',
    generation: 1,
    podName: 'runtime-1',
    podUid: 'pod-uid-1',
    grants: ['exec', 'materialize']
  } as unknown as SpawnRecord
  const { endpoint } = await fixtures.sandbox({
    workspaceRoot,
    clock: options.shimClock ?? new FakeClock(),
    backoff: new Backoff({ jitter: () => 0 }),
    handle: createExecHandler({ workspaceRoot, log: { info: () => {}, warn: () => {} } })
  })
  const dialer = fixtures.dialer({
    verifier: { reviewToken: async () => ({ authenticated: true, podName: 'runtime-1', podUid: 'pod-uid-1' }) },
    now: () => Date.now(),
    ...(options.credentialTtlMs !== undefined ? { credentialTtlMs: options.credentialTtlMs } : {}),
    log: { info: () => {}, warn: () => {} }
  })
  const connection = await dialer.connect(endpoint, record, 5_000)

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
  return {
    channel: new ShimChannel(observed, connection.issuedCredential, timers),
    connection: observed,
    sent
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

describe('shim work spanning a credential renewal', () => {
  it('kills work whose transport is replaced, so a renewal cannot orphan a running child', async () => {
    // The daemon fails pending requests on every rebind, including the routine half-TTL renewal.
    // A child whose reply has nowhere to go must die with the socket: a clone's budget outlasts a
    // renewal, so otherwise it keeps running — and holding locks — while the daemon retries.
    const { root, env, marker } = blockingRepository()
    const shimClock = new FakeClock()
    const { channel } = await channelUnderTest(root, { credentialTtlMs: 4_000, shimClock })

    const inflight = channel
      .request('exec', { tool: 'git', args: ['config', '--get', `user.${marker}`], env }, { timeoutMs: 120_000 })
      .then(() => 'resolved')
      .catch((err: Error) => err.message)
    expect(await until(() => liveGitChildren(marker) > 0)).toBe(true)

    // Renewal fires at half the TTL on the shim's own clock — the real trigger, not a close.
    shimClock.advance(2_500)
    expect(await until(() => liveGitChildren(marker) === 0)).toBe(true)
    void inflight
  })

  it('kills work when the client stops', async () => {
    // Guards the property, not one line: stop() closes the transport, so the close hook reaches
    // this too. Both would have to regress for the child to survive — which is the point.
    const { root, env, marker } = blockingRepository()
    const { channel } = await channelUnderTest(root)
    void channel
      .request('exec', { tool: 'git', args: ['config', '--get', `user.${marker}`], env }, { timeoutMs: 120_000 })
      .catch(() => undefined)
    expect(await until(() => liveGitChildren(marker) > 0)).toBe(true)
    for (const client of fixtures.clients) client.stop()
    expect(await until(() => liveGitChildren(marker) === 0)).toBe(true)
  })
})
