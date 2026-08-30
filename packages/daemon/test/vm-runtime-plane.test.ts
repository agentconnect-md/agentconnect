import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync as chmod,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Backoff, FakeClock } from '@agentconnect.md/connection'
import { ShimClient, type ShimTransport } from '../src/shim/client.js'
import { ShimServer } from '../src/shim/server.js'
import { VmDiskLayout, BOOT_SECRET_FILE, BOOT_SHARE_TAG, cloneFile } from '../src/vm/disks.js'
import { startVmRuntimePlane } from '../src/vm/runtime-plane.js'
import type { RuntimePlane } from '../src/runtime-plane/contract.js'

const servers: ShimServer[] = []
const clients: ShimClient[] = []
const planes: RuntimePlane[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const plane of planes.splice(0)) await plane.stop()
  for (const client of clients.splice(0)) client.stop()
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const silent = { info: () => {}, warn: () => {}, debug: () => {} }
const GUEST_SHIM_PORT = 8085

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vm-plane-'))
  dirs.push(dir)
  return dir
}

/** A base image bundle with recognisable bytes, so a clone can be told from an empty file. */
function baseBundle(): string {
  const dir = join(scratch(), 'base')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'disk.img'), 'ROOTFS-BYTES')
  writeFileSync(join(dir, 'kernel'), 'KERNEL')
  writeFileSync(join(dir, 'initrd.img'), 'INITRD')
  writeFileSync(join(dir, 'manifest.json'), '{"suite":"trixie"}')
  return dir
}

function diskLayout(): VmDiskLayout {
  return new VmDiskLayout({
    baseBundlePath: baseBundle(),
    root: join(scratch(), 'vms'),
    cpuCount: 1,
    memoryBytes: 2 * 1024 ** 3,
    dataDiskBytes: 1024 * 1024,
    log: silent
  })
}

function fakeVmm(hostPort: number): string {
  const path = join(scratch(), 'fake-vmm')
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
process.stdout.write(${JSON.stringify(booting)} + '\\n')
process.on('SIGTERM', () => { process.stdout.write('{"code":0,"event":"exited","reason":"guest-powered-off"}\\n'); process.exit(0) })
setInterval(() => {}, 1000)
`
  )
  chmod(path, 0o755)
  return path
}

function shimPresenting(server: ShimServer, secret: string, workspaceRoot?: string): ShimClient {
  const client = new ShimClient({
    endpoint: 'accepted-daemon-channel',
    dial: () => server.nextTransport() as Promise<ShimTransport>,
    readToken: () => secret,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    clock: new FakeClock(),
    backoff: new Backoff({ jitter: () => 0 }),
    log: { info: () => {}, warn: () => {} }
  })
  clients.push(client)
  void client.start()
  return client
}

async function planeUnderTest(options: { workspaceRoot?: string; maxConcurrentVms?: number } = {}) {
  const server = new ShimServer()
  const port = await server.start(0, '127.0.0.1')
  servers.push(server)
  const disks = diskLayout()
  // Wrap the real layout so the in-guest shim gets the secret this boot was actually issued.
  const place = disks.place.bind(disks)
  disks.place = (agentId, vmName, secret) => {
    shimPresenting(server, secret, options.workspaceRoot)
    return place(agentId, vmName, secret)
  }
  let generation = 0
  const plane = await startVmRuntimePlane({
    disks,
    vmm: { binary: fakeVmm(port), log: silent, readyTimeoutMs: 10_000 },
    nextGeneration: async () => ++generation,
    memberId: 'daemon-a',
    guestImage: async () => 'debian-13-arm64@sha256:abc',
    shimPort: GUEST_SHIM_PORT,
    bindTimeoutMs: 10_000,
    ...(options.maxConcurrentVms === undefined ? {} : { budget: { maxConcurrentVms: options.maxConcurrentVms } }),
    log: silent
  })
  planes.push(plane)
  return { plane, disks }
}

describe('VmDiskLayout', () => {
  it('clones the rootfs per boot and writes the boot secret read-only', () => {
    const disks = diskLayout()
    const placement = disks.place('agent-a', 'vm-agent-a-1', 's3cret')
    expect(readFileSync(join(placement.bundlePath, 'disk.img'), 'utf8')).toBe('ROOTFS-BYTES')
    expect(readFileSync(join(placement.bundlePath, 'kernel'), 'utf8')).toBe('KERNEL')
    expect(placement.bootShare?.tag).toBe(BOOT_SHARE_TAG)
    const secret = join(placement.bootShare!.path, BOOT_SECRET_FILE)
    expect(readFileSync(secret, 'utf8')).toBe('s3cret')
    expect(statSync(secret).mode & 0o777).toBe(0o600)
  })

  // The rootfs is disposable; the data disk is the agent's work and must outlive every boot.
  it('keeps one data disk across boots and drops only the boot when unplaced', () => {
    const disks = diskLayout()
    const first = disks.place('agent-a', 'vm-agent-a-1', 'one')
    writeFileSync(first.dataDiskPath, 'AGENT-WORK')
    disks.unplace('agent-a', 'vm-agent-a-1')
    expect(existsSync(first.bundlePath)).toBe(false)
    const second = disks.place('agent-a', 'vm-agent-a-2', 'two')
    expect(second.dataDiskPath).toBe(first.dataDiskPath)
    expect(readFileSync(second.dataDiskPath, 'utf8')).toBe('AGENT-WORK')
  })

  it('takes the data disk with it only on discard, which is agent removal', () => {
    const disks = diskLayout()
    const placement = disks.place('agent-a', 'vm-agent-a-1', 'one')
    disks.discard('agent-a')
    expect(existsSync(placement.dataDiskPath)).toBe(false)
    expect(existsSync(disks.agentRoot('agent-a'))).toBe(false)
  })

  it('falls back to a real copy where the filesystem cannot clone', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'src'), 'BYTES')
    cloneFile(join(dir, 'src'), join(dir, 'dst'), (() => ({ status: 1 })) as never)
    expect(readFileSync(join(dir, 'dst'), 'utf8')).toBe('BYTES')
  })
})

describe.skipIf(process.platform === 'win32')('startVmRuntimePlane', () => {
  it('satisfies the neutral contract the cluster plane also implements', async () => {
    const { plane } = await planeUnderTest()
    expect(plane.memberId).toBe('daemon-a')
    expect(await plane.runtimeImage()).toBe('debian-13-arm64@sha256:abc')
    // Before any boot every per-agent seam answers undefined, which keeps the caller local.
    expect(plane.runsInSandbox('agent-a')).toBe(false)
    expect(plane.gitRunnerFor('agent-a')).toBeUndefined()
    expect(plane.workspaceFsFor('agent-a')).toBeUndefined()
    expect(plane.memoryFsFor('agent-a')).toBeUndefined()
    expect(plane.launchedAgents()).toEqual([])
  })

  it('boots on demand and then serves every workspace seam from the guest', async () => {
    const { plane } = await planeUnderTest({ workspaceRoot: '/agent' })
    await plane.ensureChannel('agent-a')
    expect(plane.runsInSandbox('agent-a')).toBe(true)
    expect(plane.gitRunnerFor('agent-a')).toBeDefined()
    expect(plane.workspaceFilesFor('agent-a')).toBeDefined()
    expect(plane.autoMergeFor('agent-a')).toBeDefined()
    expect(plane.workspaceFsFor('agent-a')?.mount).toBe('/agent')
    expect(plane.memoryFsFor('agent-a')).toBeDefined()
    expect(plane.workspaceRootFor('agent-a')).toBe('/agent')
    expect(plane.shimGenerationFor?.('agent-a')).toBe(1)
    expect(plane.launchedAgents().map((e) => e.agentId)).toEqual(['agent-a'])
  })

  // A guest is a new process every boot, so callers must be able to see they have a new one.
  it('reports a new incarnation for every boot, while the data disk stays put', async () => {
    const { plane, disks } = await planeUnderTest()
    await plane.ensureChannel('agent-a')
    const first = plane.workspaceIncarnationFor?.('agent-a')
    const dataDisk = disks.dataDiskPath('agent-a')
    writeFileSync(dataDisk, 'AGENT-WORK')
    expect(await plane.suspendIdle('agent-a')).toBe('suspended')
    await plane.ensureChannel('agent-a')
    expect(plane.workspaceIncarnationFor?.('agent-a')).not.toBe(first)
    expect(readFileSync(dataDisk, 'utf8')).toBe('AGENT-WORK')
  })

  it('refuses workspace work for an agent with no guest, rather than throwing', async () => {
    const { plane } = await planeUnderTest()
    expect(await plane.clearPath('agent-a', '/agent/repo')).toMatch(/no bound guest channel/)
  })

  it('removes an agent for good, data disk included, and says what it would leave', async () => {
    const { plane, disks } = await planeUnderTest()
    await plane.ensureChannel('agent-a')
    expect(plane.describeResidue?.('agent-a')).toContain(disks.agentRoot('agent-a'))
    await plane.discardAgent('agent-a')
    expect(plane.runsInSandbox('agent-a')).toBe(false)
    expect(existsSync(disks.agentRoot('agent-a'))).toBe(false)
  })

  // Nothing to take over from: a guest dies with the daemon that booted it.
  it('adopts nothing, because a guest cannot outlive the daemon that owns it', async () => {
    const { plane } = await planeUnderTest()
    await expect(plane.adoptAgent('agent-a')).resolves.toBeUndefined()
    expect(plane.runsInSandbox('agent-a')).toBe(false)
  })

  // A refused launch must leave no trace: no generation spent, no disks, no helper process.
  it('refuses a boot past the host budget and creates nothing for it', async () => {
    const { plane, disks } = await planeUnderTest({ maxConcurrentVms: 1 })
    await plane.ensureChannel('agent-a')
    await expect(plane.ensureChannel('agent-b')).rejects.toThrow(/maxConcurrentVms/)
    expect(plane.runsInSandbox('agent-b')).toBe(false)
    expect(existsSync(disks.agentRoot('agent-b'))).toBe(false)
    // That the slot frees again is VmAdmission's own contract, tested there against the budget
    // rather than here against a shared fake shim that only ever serves one guest at a time.
  })

  it('holds the guest for the duration of withSandbox', async () => {
    const { plane } = await planeUnderTest()
    const seen = await plane.withSandbox('agent-a', async () => plane.runsInSandbox('agent-a'))
    expect(seen).toBe(true)
  })
})
