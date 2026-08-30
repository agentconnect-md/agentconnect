import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Backoff, FakeClock } from '@agentconnect.md/connection'
import { ShimClient, type ShimTransport } from '../src/shim/client.js'
import { ShimServer } from '../src/shim/server.js'
import { ShimDialer } from '../src/shim/dialer.js'
import { SHIM_TOKEN_AUDIENCE } from '../src/shim/protocol.js'
import { VmBootRegistry, vmNameFor } from '../src/vm/identity.js'
import { VmDriver } from '../src/vm/driver.js'

/**
 * The assembly, not the parts: a real daemon dialer reaches a real shim listener over a real
 * socket, authenticated by a real boot secret, through the same `ShimDialer`/`ShimSession` the
 * cluster path uses. That is the architectural claim this milestone rests on — a guest is a
 * different place to reach the shim, not a different protocol — and only an end-to-end run can
 * falsify it.
 */

const servers: ShimServer[] = []
const clients: ShimClient[] = []
const drivers: VmDriver[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.stop()
  for (const client of clients.splice(0)) client.stop()
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const silent = { info: () => {}, warn: () => {}, debug: () => {} }
const GUEST_SHIM_PORT = 8085

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vm-driver-'))
  dirs.push(dir)
  return dir
}

/** A helper stand-in that reports the guest reachable on `hostPort`, then waits to be stopped. */
function fakeVmm(hostPort: number): { path: string; argvFile: string } {
  const dir = scratch()
  const path = join(dir, 'fake-vmm')
  const argvFile = join(dir, 'argv.json')
  const booting = JSON.stringify({
    event: 'booting',
    vmmVersion: '1.0.0',
    cpuCount: 1,
    memoryBytes: 2147483648,
    kernelCommandLine: 'console=hvc0 root=/dev/vda rw',
    forwards: [{ hostPort, guestPort: GUEST_SHIM_PORT }]
  })
  writeFileSync(
    path,
    `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write(${JSON.stringify(booting)} + '\\n')
process.on('SIGTERM', () => { process.stdout.write('{"code":0,"event":"exited","reason":"guest-powered-off"}\\n'); process.exit(0) })
setInterval(() => {}, 1000)
`
  )
  chmodSync(path, 0o755)
  return { path, argvFile }
}

/** The in-guest shim, presenting this boot's secret exactly as the real one reads it off its share. */
function shimPresenting(server: ShimServer, secret: string): ShimClient {
  const client = new ShimClient({
    endpoint: 'accepted-daemon-channel',
    dial: () => server.nextTransport() as Promise<ShimTransport>,
    readToken: () => secret,
    clock: new FakeClock(),
    backoff: new Backoff({ jitter: () => 0 }),
    log: { info: () => {}, warn: () => {} }
  })
  clients.push(client)
  void client.start()
  return client
}

async function driverUnderTest(
  options: { secretFor?: (real: string) => string; bindTimeoutMs?: number; bootShare?: boolean } = {}
) {
  const server = new ShimServer()
  const port = await server.start(0, '127.0.0.1')
  servers.push(server)

  const helper = fakeVmm(port)
  const identities = new VmBootRegistry()
  const dialer = new ShimDialer({ verifier: identities, log: { info: () => {}, warn: () => {} } })
  let generation = 0
  const placed: string[] = []
  const unplaced: string[] = []

  const driver = new VmDriver({
    dialer,
    identities,
    nextGeneration: async () => ++generation,
    place: async (_agentId, vmName, secret) => {
      placed.push(vmName)
      shimPresenting(server, options.secretFor ? options.secretFor(secret) : secret)
      const dir = scratch()
      return {
        bundlePath: dir,
        dataDiskPath: join(dir, 'data.img'),
        consoleLogPath: join(dir, 'console.log'),
        cpuCount: 1,
        memoryBytes: 2 * 1024 ** 3,
        ...(options.bootShare ? { bootShare: { tag: 'boot', path: join(dir, 'boot') } } : {})
      }
    },
    unplace: async (_agentId, vmName) => void unplaced.push(vmName),
    vmm: { binary: helper.path, log: silent, readyTimeoutMs: 10_000 },
    shimPort: GUEST_SHIM_PORT,
    bindTimeoutMs: options.bindTimeoutMs ?? 10_000,
    log: silent
  })
  drivers.push(driver)
  return { driver, identities, placed, unplaced, argvFile: helper.argvFile }
}

describe('VmBootRegistry', () => {
  it('accepts only the secret it minted, for the audience the shim endpoint pins', async () => {
    const registry = new VmBootRegistry()
    const token = registry.issue('vm-a-1')
    expect(await registry.reviewToken(token, [SHIM_TOKEN_AUDIENCE])).toMatchObject({
      authenticated: true,
      podName: 'vm-a-1'
    })
    expect(await registry.reviewToken('guessed', [SHIM_TOKEN_AUDIENCE])).toMatchObject({ authenticated: false })
    // A token minted for anything else must not authenticate here, which is what makes the secret
    // safe to hand a guest: it is useless anywhere but this endpoint.
    expect(await registry.reviewToken(token, ['some-other-audience'])).toMatchObject({ authenticated: false })
  })

  // A guest outliving its launch must not be able to answer for its successor.
  it('stops accepting a boot secret once that boot is over', async () => {
    const registry = new VmBootRegistry()
    const token = registry.issue('vm-a-1')
    registry.revoke('vm-a-1')
    expect(await registry.reviewToken(token, [SHIM_TOKEN_AUDIENCE])).toMatchObject({ authenticated: false })
  })

  it('names a boot so a replacement is a different peer', () => {
    expect(vmNameFor('agent-a', 1)).toBe('vm-agent-a-1')
    expect(vmNameFor('agent-a', 2)).not.toBe(vmNameFor('agent-a', 1))
  })
})

describe.skipIf(process.platform === 'win32')('VmDriver', () => {
  it('boots a guest and binds its shim over the very path the cluster uses', async () => {
    const { driver } = await driverUnderTest()
    const launch = await driver.ensureChannel('agent-a')
    expect(launch.vmName).toBe('vm-agent-a-1')
    expect(launch.session.generation).toBe(1)
    expect(driver.runsInSandbox('agent-a')).toBe(true)
    expect(driver.sessionFor('agent-a')).toBe(launch.session)
  })

  // Two turns arriving together must not boot two guests for one agent.
  it('single-flights a boot, and reuses the bound one after', async () => {
    const { driver, placed } = await driverUnderTest()
    const [first, second] = await Promise.all([driver.ensureChannel('agent-a'), driver.ensureChannel('agent-a')])
    expect(first).toBe(second)
    expect(await driver.ensureChannel('agent-a')).toBe(first)
    expect(placed).toEqual(['vm-agent-a-1'])
  })

  it('refuses a guest that cannot prove which boot it is', async () => {
    // A short budget: the dialer is expected to keep retrying a peer it cannot bind, so the
    // assertion is that it never binds, not how long it is willing to wait.
    const { driver } = await driverUnderTest({ secretFor: () => 'not-the-minted-secret', bindTimeoutMs: 750 })
    await expect(driver.ensureChannel('agent-a')).rejects.toThrow()
    expect(driver.runsInSandbox('agent-a')).toBe(false)
  })

  it('will not start a runtime without the agent the launch belongs to', async () => {
    const { driver } = await driverUnderTest()
    await expect(driver.launch({ command: 'x', args: [], env: {} })).rejects.toThrow(/AC_AGENT_ID/)
  })

  it('releases the guest, retires its secret, and gives back what was placed', async () => {
    const { driver, identities, unplaced } = await driverUnderTest()
    const launch = await driver.ensureChannel('agent-a')
    await driver.releaseAgent('agent-a')
    expect(driver.runsInSandbox('agent-a')).toBe(false)
    expect(unplaced).toEqual(['vm-agent-a-1'])
    expect(await identities.reviewToken('anything', [SHIM_TOKEN_AUDIENCE])).toMatchObject({ authenticated: false })
    expect((await launch.vm.exited).reason).toBe('guest-powered-off')
  })

  // Suspension keeps the data disk, so the next turn boots onto the same workspace.
  // Without this the idle sweep suspends a guest with a prompt in flight, and the runtime loses
  // its channel mid-turn: the daemon reports a lost channel and the agent's work is simply gone.
  it('refuses to suspend a guest that work is still holding', async () => {
    const { driver } = await driverUnderTest()
    await driver.ensureChannel('agent-a')
    driver.retain('agent-a')
    expect(await driver.suspend('agent-a')).toBe('busy')
    expect(driver.runsInSandbox('agent-a')).toBe(true)
    driver.releaseHold('agent-a')
    expect(await driver.suspend('agent-a')).toBe('suspended')
  })

  it('counts holds, so nested work does not release early', async () => {
    const { driver } = await driverUnderTest()
    await driver.ensureChannel('agent-a')
    driver.retain('agent-a')
    driver.retain('agent-a')
    driver.releaseHold('agent-a')
    expect(await driver.suspend('agent-a')).toBe('busy')
    driver.releaseHold('agent-a')
    expect(await driver.suspend('agent-a')).toBe('suspended')
  })

  it('suspends to nothing when there is no guest, and reports what it did when there is', async () => {
    const { driver } = await driverUnderTest()
    expect(await driver.suspend('agent-a')).toBe('absent')
    await driver.ensureChannel('agent-a')
    expect(await driver.suspend('agent-a')).toBe('suspended')
  })

  it('counts a guest as launched only while it is actually up', async () => {
    const { driver } = await driverUnderTest()
    expect(driver.launchedAgents()).toEqual([])
    await driver.ensureChannel('agent-a')
    expect(driver.launchedAgents().map((entry) => entry.agentId)).toEqual(['agent-a'])
    await driver.releaseAgent('agent-a')
    expect(driver.launchedAgents()).toEqual([])
  })

  // The boot secret reaches the guest as a read-only share, so it must actually be on the argv.
  it('hands the guest its boot secret as a read-only share', async () => {
    const { driver, argvFile } = await driverUnderTest({ bootShare: true })
    await driver.ensureChannel('agent-a')
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[]
    expect(argv).toContain('--share')
    expect(argv.some((arg) => arg.startsWith('boot=') && arg.endsWith(':ro'))).toBe(true)
    expect(argv).toContain(`0:${GUEST_SHIM_PORT}`)
  })

  // The shim closes its own channel at half the credential TTL so the daemon reconnects. Treating
  // that as a lost launch stopped the guest mid-prompt and the runtime died on a broken pipe.
  it('keeps the launch across a channel drop, because the shim reconnects', async () => {
    const { driver } = await driverUnderTest()
    const launch = await driver.ensureChannel('agent-a')
    driver.onChannelLost('agent-a', 'credential renewal')
    expect(driver.runsInSandbox('agent-a')).toBe(true)
    expect(driver.currentLaunch('agent-a')).toBe(launch)
  })

  // The next turn must boot a fresh generation rather than bind a session whose peer is gone.
  it('ends the launch when the guest goes away on its own', async () => {
    const { driver } = await driverUnderTest()
    const launch = await driver.ensureChannel('agent-a')
    await launch.vm.stop(2000)
    await vi.waitFor(() => expect(driver.runsInSandbox('agent-a')).toBe(false))
  })
})
