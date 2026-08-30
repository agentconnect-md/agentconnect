import { afterAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchVmm, vmmArgs } from '../src/vm/vmm-process.js'
import { parseVmmEvent } from '../src/vm/events.js'

// Captured verbatim from a real `agentconnect-vmm` run booting a Debian guest. Kept as bytes rather
// than rebuilt from the schema so a drift in the Swift encoder fails here instead of at launch.
const REAL_BOOTING =
  '{"cpuCount":2,"dataDisk":"/var/agent-data.img","event":"booting",' +
  '"forwards":[{"guestPort":22,"hostPort":52308}],' +
  '"kernelCommandLine":"console=hvc0 root=/dev/vda rw loglevel=4",' +
  '"memoryBytes":2147483648,"vmmVersion":"1.0.0"}'
const REAL_EXITED = '{"code":0,"event":"exited","reason":"guest-powered-off"}'

const silent = { info: () => {}, warn: () => {}, debug: () => {} }

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vmm-test-'))
  dirs.push(dir)
  return dir
}
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

/** A stand-in helper: emits the given stdout lines, then behaves as `mode` says. */
function fakeVmm(lines: string[], mode: 'hold' | 'exit-now' | 'ignore-sigterm'): string {
  const dir = scratch()
  const path = join(dir, 'fake-vmm')
  writeFileSync(
    path,
    `#!/usr/bin/env node
for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + '\\n')
if (${JSON.stringify(mode)} === 'exit-now') process.exit(3)
if (${JSON.stringify(mode)} === 'ignore-sigterm') process.on('SIGTERM', () => {})
else process.on('SIGTERM', () => { process.stdout.write(${JSON.stringify(REAL_EXITED)} + '\\n'); process.exit(0) })
setInterval(() => {}, 1000)
`
  )
  chmodSync(path, 0o755)
  return path
}

const launch = {
  bundlePath: '/tmp/bundle',
  dataDiskPath: '/var/agent-data.img',
  consoleLogPath: '/var/console.log',
  cpuCount: 1,
  memoryBytes: 2 * 1024 ** 3,
  shimPort: 22
}

describe('vmm event parsing', () => {
  it('reads the bytes a real helper actually emits', () => {
    expect(parseVmmEvent(REAL_BOOTING)).toMatchObject({
      event: 'booting',
      vmmVersion: '1.0.0',
      forwards: [{ guestPort: 22, hostPort: 52308 }]
    })
    expect(parseVmmEvent(REAL_EXITED)).toEqual({ event: 'exited', code: 0, reason: 'guest-powered-off' })
  })

  // The helper writes human warnings too, and a newer one may emit events this daemon predates.
  it('ignores anything that is not an event it knows', () => {
    expect(parseVmmEvent('vmm: booting trixie/arm64')).toBeUndefined()
    expect(parseVmmEvent('')).toBeUndefined()
    expect(parseVmmEvent('{"event":"warmed","what":"future"}')).toBeUndefined()
    expect(parseVmmEvent('{not json')).toBeUndefined()
  })

  it('refuses an exit reason it cannot act on', () => {
    expect(parseVmmEvent('{"code":0,"event":"exited","reason":"vibes"}')).toBeUndefined()
  })
})

describe('vmmArgs', () => {
  it('asks for an ephemeral host port and passes the two disks separately', () => {
    expect(vmmArgs(launch)).toEqual([
      'run',
      '/tmp/bundle',
      '--cpus',
      '1',
      '--memory',
      String(2 * 1024 ** 3),
      '--data-disk',
      '/var/agent-data.img',
      '--console-log',
      '/var/console.log',
      '--forward',
      '0:22',
      '--json'
    ])
  })

  it('renders read-only shares with the suffix the helper parses', () => {
    const args = vmmArgs({ ...launch, shares: [{ tag: 'boot', path: '/run/tok', readOnly: true }] })
    expect(args).toContain('--share')
    expect(args).toContain('boot=/run/tok:ro')
  })
})

describe.skipIf(process.platform === 'win32')('launchVmm', () => {
  it('resolves with the loopback port the kernel chose, not the one requested', async () => {
    const vm = await launchVmm(launch, { binary: fakeVmm([REAL_BOOTING], 'hold'), log: silent })
    expect(vm.hostPort).toBe(52308)
    await vm.stop(2000)
  })

  it('reads past the helper warnings that share the stream', async () => {
    const binary = fakeVmm(['vmm: booting trixie/arm64', 'noise', REAL_BOOTING], 'hold')
    const vm = await launchVmm(launch, { binary, log: silent })
    expect(vm.hostPort).toBe(52308)
    await vm.stop(2000)
  })

  // A configuration the hypervisor rejected must surface as a launch failure, never as a hang.
  it('fails when the helper exits before it reports booting', async () => {
    const binary = fakeVmm(['{"code":1,"event":"exited","reason":"start-failed"}'], 'exit-now')
    await expect(launchVmm(launch, { binary, log: silent })).rejects.toThrow(/start-failed/)
  })

  // The forward is the only way in, so a boot without one is dead on arrival and must not be held.
  it('fails when no host port was bound for the guest shim port', async () => {
    const orphan = REAL_BOOTING.replace('"guestPort":22', '"guestPort":9515')
    const binary = fakeVmm([orphan], 'hold')
    await expect(launchVmm(launch, { binary, log: silent })).rejects.toThrow(/no host port/)
  })

  it('gives up and kills a helper that never reports', async () => {
    const binary = fakeVmm([], 'hold')
    await expect(launchVmm(launch, { binary, log: silent, readyTimeoutMs: 300 })).rejects.toThrow(/within 300ms/)
  })

  it('stops gracefully and reports how the guest went down', async () => {
    const vm = await launchVmm(launch, { binary: fakeVmm([REAL_BOOTING], 'hold'), log: silent })
    await vm.stop(2000)
    expect(await vm.exited).toEqual({ code: 0, reason: 'guest-powered-off' })
  })

  it('forces power off when the guest ignores the shutdown request', async () => {
    const binary = fakeVmm([REAL_BOOTING], 'ignore-sigterm')
    const warnings: string[] = []
    const vm = await launchVmm(launch, { binary, log: { ...silent, warn: (m) => warnings.push(m) } })
    await vm.stop(300)
    expect(warnings.join()).toMatch(/forcing power off/)
    expect((await vm.exited).code).not.toBe(0)
  })

  it('is safe to stop twice, and after the guest is already gone', async () => {
    const vm = await launchVmm(launch, { binary: fakeVmm([REAL_BOOTING], 'hold'), log: silent })
    await vm.stop(2000)
    await expect(vm.stop(2000)).resolves.toBeUndefined()
  })
})
