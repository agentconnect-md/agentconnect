/**
 * The in-cluster credential: an operator-provisioned daemon presents the projected
 * ServiceAccount token instead of an API key, and re-reads it on every connect because the
 * kubelet rotates it roughly hourly.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CP_IDENTITY_TOKEN_PATH } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { readClusterIdentityToken } from '../../src/cp/cluster-identity.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const tick = () => new Promise((r) => setImmediate(r))
const dirs: string[] = []

function tempTokenFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-identity-'))
  dirs.push(dir)
  const path = join(dir, 'token')
  writeFileSync(path, contents)
  return path
}

function makeDeps(transport: FakeTransport, over: Partial<CpClientDeps> = {}): CpClientDeps {
  return {
    url: 'wss://cp.example/daemon/ws',
    agentVersion: '0.0.0',
    host: 'host-1',
    heartbeatDefaultMs: 15000,
    maxAgents: 4,
    capabilities: () => ({ platforms: [], runtimes: [], acp: true, features: [] }),
    runtimeProfiles: () => [],
    localState: () => ({ assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }),
    loadSnapshot: () => ({ cpu: 0, mem: 0, agents: 0 }),
    activeSessions: () => 0,
    configApply: {
      applyConfigPush() {},
      applyReconcileSnapshot() {},
      upsertCron() {},
      removeCron() {},
      applyRouteAssign() {},
      applyRouteUpdate() {}
    },
    clock: new FakeClock(),
    connect: async () => transport,
    log: silent,
    jitter: () => 0,
    ...over
  } as CpClientDeps
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readClusterIdentityToken', () => {
  it('reads and trims the projected token', () => {
    expect(readClusterIdentityToken(tempTokenFile('projected-token\n'))).toBe('projected-token')
  })

  it('is undefined off-cluster, where the file does not exist', () => {
    expect(readClusterIdentityToken(join(tmpdir(), 'ac-identity-absent', 'token'))).toBeUndefined()
  })

  it('is undefined for an empty file rather than presenting a blank credential', () => {
    expect(readClusterIdentityToken(tempTokenFile('  \n'))).toBeUndefined()
  })

  it('defaults to the path the deployment projects it at', () => {
    expect(CP_IDENTITY_TOKEN_PATH.startsWith('/')).toBe(true)
  })
})

describe('CpClient auth credential', () => {
  it('presents the projected token and no API key when one is available', async () => {
    const t = new FakeTransport()
    const client = new CpClient(makeDeps(t, { token: 'ac_daemon_key', clusterIdentityToken: () => 'projected-token' }))
    client.start()
    await tick()
    const auth = t.lastSent()
    expect(auth.type).toBe('auth')
    expect(auth.payload.serviceAccountToken).toBe('projected-token')
    expect(auth.payload.apiKey).toBeUndefined()
    expect(auth.payload.orgId).toBeUndefined()
  })

  it('falls back to the API key when this daemon has no Kubernetes identity', async () => {
    const t = new FakeTransport()
    const client = new CpClient(makeDeps(t, { token: 'ac_daemon_key', clusterIdentityToken: () => undefined }))
    client.start()
    await tick()
    expect(t.lastSent().payload).toMatchObject({ apiKey: 'ac_daemon_key' })
    expect(t.lastSent().payload.serviceAccountToken).toBeUndefined()
  })

  it('never echoes a daemonId on the identity path, where the CP re-derives it', async () => {
    const t = new FakeTransport()
    const client = new CpClient(
      makeDeps(t, { daemonId: '22222222-2222-4222-8222-222222222222', clusterIdentityToken: () => 'projected-token' })
    )
    client.start()
    await tick()
    expect(t.lastSent().payload.daemonId).toBeUndefined()
  })

  it('re-reads the token per connect, so an hourly rotation is picked up', async () => {
    const reads: string[] = []
    let current = 'token-1'
    const clock = new FakeClock()
    const first = new FakeTransport()
    const second = new FakeTransport()
    const transports = [first, second]
    const client = new CpClient(
      makeDeps(first, {
        clock,
        clusterIdentityToken: () => {
          reads.push(current)
          return current
        },
        connect: async () => transports.shift() ?? new FakeTransport()
      })
    )
    client.start()
    await tick()
    expect(first.lastSent().payload.serviceAccountToken).toBe('token-1')

    // The kubelet rewrites the file, then the socket drops and the client redials.
    current = 'token-2'
    first.simulateClose(1006, 'gone')
    await tick()
    clock.advance(5_000)
    await tick()
    expect(second.lastSent().payload.serviceAccountToken).toBe('token-2')
    expect(reads).toEqual(['token-1', 'token-2'])
  })
})

describe('CpClient terminal auth rejection', () => {
  it('asks the daemon to exit when the CP rejects the projected identity — the restart is the retry', async () => {
    // A member that stays up after a 4401 can never become servable: nothing redials, and boot
    // blocks on the first registration. Exiting hands the retry to the supervisor's backoff.
    const clock = new FakeClock()
    const t = new FakeTransport()
    const onAuthFatal = vi.fn()
    const connect = vi.fn(async () => t)
    const client = new CpClient(
      makeDeps(t, { clock, connect, clusterIdentityToken: () => 'projected-token', onAuthFatal })
    )
    client.start()
    await tick()

    t.simulateClose(4401, 'AUTH_FAILED')
    expect(onAuthFatal).toHaveBeenCalledTimes(1)
    expect(client.state).toBe('CLOSED')
    // No in-process redial: the backoff that paces the retry is the supervisor's, not ours.
    expect(clock.pending()).not.toContain(1000)
    clock.advance(60_000)
    await tick()
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('stays up on an API-key 4401, where only an operator can mint a new credential', async () => {
    const clock = new FakeClock()
    const t = new FakeTransport()
    const onAuthFatal = vi.fn()
    const client = new CpClient(makeDeps(t, { clock, token: 'ac_daemon_key', onAuthFatal }))
    client.start()
    await tick()

    t.simulateClose(4401, 'AUTH_FAILED')
    expect(onAuthFatal).not.toHaveBeenCalled()
    expect(client.state).toBe('CLOSED')
  })

  it('exits on a 4401 taken by a reconnect, not just the first dial', async () => {
    // The rejection that stranded a member arrived on a redial into a control plane mid-restart.
    const clock = new FakeClock()
    const first = new FakeTransport()
    const second = new FakeTransport()
    const transports = [first, second]
    const onAuthFatal = vi.fn()
    const client = new CpClient(
      makeDeps(first, {
        clock,
        clusterIdentityToken: () => 'projected-token',
        onAuthFatal,
        connect: async () => transports.shift() ?? new FakeTransport()
      })
    )
    client.start()
    await tick()

    first.simulateClose(1006, 'gone')
    await tick()
    expect(onAuthFatal).not.toHaveBeenCalled()
    clock.advance(5_000)
    await tick()

    second.simulateClose(4401, 'AUTH_FAILED')
    expect(onAuthFatal).toHaveBeenCalledTimes(1)
  })
})
