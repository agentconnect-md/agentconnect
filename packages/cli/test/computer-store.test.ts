import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_SERVICE_ENTRY_ENV, storeEntry, versionEntry, type DesktopLaunch } from '../src/computer/launch.js'
import { childEnv, type EntryRunner } from '../src/computer/run.js'
import {
  DESKTOP_STORE,
  installComputer,
  realComputerOps,
  upgradeComputer,
  type ComputerOps
} from '../src/computer/store.js'
import { setupArgs, targetOpts } from '../src/computer/commands.js'
import { installTarget, resolveTarget } from '../src/install.js'
import { DESKTOP_PKG, type ResolvedTarget } from '../src/registry.js'
import { useVersion } from '../src/version-ops.js'
import { currentVersion, listInstalled, readMeta } from '../src/version-store.js'

const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

// A fake npm registry serving only @agentconnect.md/desktop, with tarballs packed like `npm pack` (`package/` prefix).
interface FakeVersion {
  version: string
  entry?: boolean
  engines?: string
  corrupt?: boolean
}

let server: Server
let base = ''
const requested: string[] = []
const tarballs = new Map<string, Buffer>()
let packument: Record<string, unknown> = {}

function pack(v: FakeVersion): Buffer {
  const dir = tmp('ac-desktop-pkg-')
  mkdirSync(join(dir, 'package', 'dist'), { recursive: true })
  writeFileSync(
    join(dir, 'package', 'package.json'),
    JSON.stringify({ name: DESKTOP_PKG, version: v.version, engines: { node: v.engines ?? '>=24.12.0' } })
  )
  if (v.entry !== false) writeFileSync(join(dir, 'package', 'dist', 'agentconnect-desktop.mjs'), `// ${v.version}\n`)
  const buf = execFileSync('tar', ['-czf', '-', '-C', dir, 'package'])
  rmSync(dir, { recursive: true, force: true })
  return buf
}

function publish(versions: FakeVersion[], tags: Record<string, string>): void {
  const entries: Record<string, unknown> = {}
  for (const v of versions) {
    const buf = pack(v)
    tarballs.set(v.version, buf)
    const integrity = `sha512-${createHash('sha512')
      .update(v.corrupt ? Buffer.from('other bytes') : buf)
      .digest('base64')}`
    entries[v.version] = {
      version: v.version,
      engines: { node: v.engines ?? '>=24.12.0' },
      dist: { tarball: `${base}/tarballs/${v.version}.tgz`, integrity }
    }
  }
  packument = { name: DESKTOP_PKG, 'dist-tags': tags, versions: entries }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    requested.push(req.url ?? '')
    if (req.url === '/@agentconnect.md%2Fdesktop') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify(packument))
    }
    const tarball = /^\/tarballs\/(.+)\.tgz$/.exec(req.url ?? '')?.[1]
    const buf = tarball ? tarballs.get(tarball) : undefined
    if (buf) return res.end(buf)
    res.statusCode = 404
    res.end('not found')
  })
  server.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  vi.stubEnv('AGENTCONNECT_NPM_REGISTRY', base)
})

afterAll(() => {
  vi.unstubAllEnvs()
  server.close()
})

beforeEach(() => {
  requested.length = 0
  publish(
    [
      { version: '2.5.0' },
      { version: '2.6.0' },
      { version: '2.7.0-rc.1' },
      { version: '9.9.9-noentry', entry: false },
      { version: '9.9.9-corrupt', corrupt: true },
      { version: '9.9.9-future', engines: '>=99' }
    ],
    { latest: '2.6.0', rc: '2.7.0-rc.1' }
  )
})

describe('computer package: resolve', () => {
  it('resolves the channel dist-tag or an explicit version of the desktop package only', async () => {
    expect((await resolveTarget({ channel: 'stable' }, DESKTOP_PKG)).version).toBe('2.6.0')
    expect((await resolveTarget({ channel: 'rc' }, DESKTOP_PKG)).version).toBe('2.7.0-rc.1')
    expect((await resolveTarget({ to: '2.5.0', channel: 'rc' }, DESKTOP_PKG)).version).toBe('2.5.0')
    await expect(resolveTarget({ to: '1.0.0', channel: 'stable' }, DESKTOP_PKG)).rejects.toThrow(
      /@agentconnect\.md\/desktop@1\.0\.0 does not exist/
    )
    await expect(resolveTarget({ to: '--root=/x', channel: 'stable' }, DESKTOP_PKG)).rejects.toThrow(/invalid version/)
    expect(requested.every((url) => url === '/@agentconnect.md%2Fdesktop')).toBe(true)
  })
})

describe('computer package: download, verify, install', () => {
  const install = async (root: string, version: string): Promise<string> =>
    installTarget(root, await resolveTarget({ to: version, channel: 'stable' }, DESKTOP_PKG), () => {}, {
      pkg: DESKTOP_STORE
    })

  it('extracts a verified tarball into versions/<v> with its entry', async () => {
    const root = tmp('ac-computer-')
    expect(await install(root, '2.6.0')).toBe('2.6.0')
    expect(readFileSync(versionEntry(root, '2.6.0'), 'utf8')).toBe('// 2.6.0\n')
    expect(listInstalled(root)).toEqual(['2.6.0'])
  })

  it('refuses bytes that do not match the registry integrity, and leaves nothing behind', async () => {
    const root = tmp('ac-computer-')
    await expect(install(root, '9.9.9-corrupt')).rejects.toThrow(/integrity check failed/)
    expect(listInstalled(root)).toEqual([])
  })

  it('refuses a tarball without the daemon bundle', async () => {
    const root = tmp('ac-computer-')
    await expect(install(root, '9.9.9-noentry')).rejects.toThrow(
      /computer daemon 9\.9\.9-noentry tarball has no dist\/agentconnect-desktop\.mjs/
    )
    expect(listInstalled(root)).toEqual([])
  })

  it('refuses a version whose engines this Node does not satisfy before downloading it', async () => {
    const root = tmp('ac-computer-')
    await expect(install(root, '9.9.9-future')).rejects.toThrow(/requires Node >=99/)
    expect(requested.some((url) => url.startsWith('/tarballs/'))).toBe(false)
  })
})

describe('installComputer', () => {
  const ops = (root: string) => {
    const real = realComputerOps(root, { run: async () => ({ code: 0, stdout: '' }), log: () => {} })
    return { ...real, prune: vi.fn(real.prune) }
  }

  it('installs and activates the channel latest, then a pinned version, keeping the old one as previous', async () => {
    const root = tmp('ac-computer-')
    const o = ops(root)
    expect(await installComputer(root, {}, o, 'agentconnect computer')).toBe('2.6.0')
    expect(currentVersion(root)).toBe('2.6.0')
    expect(await installComputer(root, { version: '2.5.0' }, o, 'agentconnect computer')).toBe('2.5.0')
    expect(currentVersion(root)).toBe('2.5.0')
    expect(readMeta(root).previous).toBe('2.6.0')
    expect(o.prune).toHaveBeenLastCalledWith({ keep: 3, protect: ['2.5.0'] })
  })

  it('stores an explicitly chosen channel for later upgrades', async () => {
    const root = tmp('ac-computer-')
    expect(await installComputer(root, { channel: 'rc' }, ops(root), 'agentconnect computer')).toBe('2.7.0-rc.1')
    expect(readMeta(root).channel).toBe('rc')
  })
})

describe('upgradeComputer', () => {
  const target = (v: string): ResolvedTarget => ({ version: v, tarball: 'x', integrity: 'sha512-x' })
  const seed = (root: string, ...versions: string[]): void => {
    for (const v of versions) mkdirSync(join(root, 'versions', v), { recursive: true })
    useVersion(root, versions[0]!)
  }

  function fakeOps(over: Partial<ComputerOps> = {}): ComputerOps & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      resolve: async ({ to }) => target(to ?? '2.0.0'),
      install: async (root, t) => {
        mkdirSync(join(root, 'versions', t.version), { recursive: true })
        calls.push(`install ${t.version}`)
        return t.version
      },
      serviceRunsStore: true,
      status: async (v) => {
        calls.push(`status ${v}`)
        return { installed: true, running: true, pid: 10, label: 'agentconnect-desktop.service' }
      },
      refresh: async (v) => void calls.push(`refresh ${v}`),
      restart: async (v) => void calls.push(`restart ${v}`),
      health: async (v) => {
        calls.push(`health ${v}`)
        return { healthy: true, reason: 'stable pid 11' }
      },
      prune: vi.fn(() => []),
      log: () => {},
      ...over
    }
  }

  it('installs side by side, switches current, rewrites and restarts the service, then checks it', async () => {
    const root = tmp('ac-computer-')
    seed(root, '1.0.0')
    const ops = fakeOps()
    expect(await upgradeComputer(root, {}, ops, 'ac computer')).toBe('2.0.0')
    expect(currentVersion(root)).toBe('2.0.0')
    expect(readMeta(root).previous).toBe('1.0.0')
    expect(ops.calls).toEqual(['install 2.0.0', 'status 1.0.0', 'refresh 2.0.0', 'restart 2.0.0', 'health 2.0.0'])
    expect(ops.prune).toHaveBeenCalledWith({ keep: 3, protect: ['2.0.0'] })
  })

  it('rolls back to the previous version and restarts it when the health check fails', async () => {
    const root = tmp('ac-computer-')
    seed(root, '1.0.0')
    const ops = fakeOps({
      health: async () => ({ healthy: false, reason: 'pid changed 11 → 12 (crash-looping)' })
    })
    await expect(upgradeComputer(root, { version: '2.0.0' }, ops, 'ac computer')).rejects.toThrow(
      /upgrade to 2\.0\.0 failed \(health check failed: pid changed.*\) — rolled back to 1\.0\.0/
    )
    expect(currentVersion(root)).toBe('1.0.0')
    expect(ops.calls.slice(-2)).toEqual(['refresh 1.0.0', 'restart 1.0.0'])
    // The failed version stays installed for diagnosis and becomes the recorded previous.
    expect(listInstalled(root)).toContain('2.0.0')
    expect(readMeta(root).previous).toBe('2.0.0')
    expect(ops.prune).not.toHaveBeenCalled()
  })

  it('rolls back when the new version cannot install its service or restart', async () => {
    for (const broken of ['refresh', 'restart'] as const) {
      const root = tmp('ac-computer-')
      seed(root, '1.0.0')
      const ops = fakeOps({
        [broken]: async (v: string) => {
          if (v === '2.0.0') throw new Error(`${broken} exploded`)
        }
      })
      await expect(upgradeComputer(root, {}, ops, 'ac computer')).rejects.toThrow(/rolled back to 1\.0\.0/)
      expect(currentVersion(root)).toBe('1.0.0')
    }
  })

  it('switches without restarting when the service is installed but not running', async () => {
    const root = tmp('ac-computer-')
    seed(root, '1.0.0')
    const ops = fakeOps({ status: async () => ({ installed: true, running: false, label: 'unit' }) })
    await upgradeComputer(root, {}, ops, 'ac computer')
    expect(currentVersion(root)).toBe('2.0.0')
    expect(ops.calls).toEqual(['install 2.0.0', 'refresh 2.0.0'])
  })

  it('only switches current when no service runs the store (no unit, or a platform whose service is the app)', async () => {
    for (const over of [
      { status: async () => ({ installed: false, running: false, label: 'unit' }) },
      { serviceRunsStore: false }
    ]) {
      const root = tmp('ac-computer-')
      seed(root, '1.0.0')
      const ops = fakeOps(over)
      await upgradeComputer(root, {}, ops, 'ac computer')
      expect(currentVersion(root)).toBe('2.0.0')
      expect(ops.calls.filter((c) => /refresh|restart|health/.test(c))).toEqual([])
    }
  })

  it('is a no-op on the current version and records a newly chosen channel', async () => {
    const root = tmp('ac-computer-')
    seed(root, '2.0.0')
    const ops = fakeOps()
    await upgradeComputer(root, { channel: 'rc' }, ops, 'ac computer')
    expect(ops.calls).toEqual(['install 2.0.0'])
    expect(readMeta(root).channel).toBe('rc')
  })
})

describe('realComputerOps against the installed daemon', () => {
  // A scripted daemon: `service status` reports a pid per call, `status` answers with a version.
  function scripted(root: string, script: { pids: number[]; answers: (string | undefined)[] }) {
    const seen: DesktopLaunch[] = []
    const run: EntryRunner = async (launch) => {
      seen.push(launch)
      const args = launch.args.slice(1).join(' ')
      if (args === 'service status') {
        const pid = script.pids.length > 1 ? script.pids.shift()! : script.pids[0]!
        return { code: 0, stdout: JSON.stringify({ installed: true, loaded: true, pid, unit: 'unit' }) }
      }
      if (args === 'status') {
        const version = script.answers.length > 1 ? script.answers.shift() : script.answers[0]
        return version ? { code: 0, stdout: JSON.stringify({ status: 'idle', version }) } : { code: 1, stdout: '' }
      }
      return { code: 0, stdout: '' }
    }
    const ops = realComputerOps(root, { run, log: () => {}, platform: 'linux', node: '/n', readyMs: 0, settleMs: 0 })
    return { ops, seen }
  }

  it('runs the given version entry and points its service at the stable current entry', async () => {
    const root = tmp('ac-computer-')
    const { ops, seen } = scripted(root, { pids: [5], answers: ['2.0.0'] })
    await ops.restart('2.0.0')
    expect(seen[0]).toEqual({
      command: '/n',
      args: [versionEntry(root, '2.0.0', 'linux'), 'service', 'restart'],
      serviceEntry: storeEntry(root, 'linux')
    })
    expect(childEnv(seen[0]!, 'ac computer')[DESKTOP_SERVICE_ENTRY_ENV]).toBe(storeEntry(root, 'linux'))
    expect(childEnv({ command: '/app', args: [] }, 'ac computer')[DESKTOP_SERVICE_ENTRY_ENV]).toBeUndefined()
  })

  it('is healthy only with a stable pid and the daemon answering as the new version', async () => {
    const root = tmp('ac-computer-')
    expect((await scripted(root, { pids: [5], answers: ['2.0.0'] }).ops.health('2.0.0')).healthy).toBe(true)
    const looping = await scripted(root, { pids: [5, 6], answers: ['2.0.0'] }).ops.health('2.0.0')
    expect(looping).toEqual({ healthy: false, reason: 'pid changed 5 → 6 (crash-looping)' })
    const old = await scripted(root, { pids: [5], answers: ['1.0.0'] }).ops.health('2.0.0')
    expect(old.reason).toMatch(/did not answer as 2\.0\.0/)
    const silent = await scripted(root, { pids: [5], answers: [undefined] }).ops.health('2.0.0')
    expect(silent.healthy).toBe(false)
  })

  it('reports a missing or unreadable service as not installed', async () => {
    const root = tmp('ac-computer-')
    const ops = realComputerOps(root, { run: async () => ({ code: 1, stdout: 'boom' }), log: () => {} })
    expect(await ops.status('1.0.0')).toEqual({ installed: false, running: false, label: 'computer daemon service' })
    await expect(ops.refresh('1.0.0')).rejects.toThrow(/service install exited 1: boom/)
  })

  it('upgrades end to end from the fake registry with the scripted daemon', async () => {
    const root = tmp('ac-computer-')
    const { ops } = scripted(root, { pids: [7], answers: ['2.6.0'] })
    await installComputer(root, { version: '2.5.0' }, ops, 'ac computer')
    expect(await upgradeComputer(root, {}, ops, 'ac computer')).toBe('2.6.0')
    expect(currentVersion(root)).toBe('2.6.0')
    expect(existsSync(storeEntry(root))).toBe(true)
  })
})

describe('computer command arguments', () => {
  it('forwards registration, service choice and unknown setup options', () => {
    expect(
      setupArgs({ register: 'tok', cpUrl: 'https://cp', name: 'desk', service: false }, ['--host', '0.0.0.0'])
    ).toEqual([
      'setup',
      '--register',
      'tok',
      '--cp-url',
      'https://cp',
      '--name',
      'desk',
      '--no-service',
      '--host',
      '0.0.0.0'
    ])
    expect(setupArgs({ service: true }, [])).toEqual(['setup'])
  })

  it('validates channel and retention', () => {
    expect(targetOpts({ version: '2.6.0', channel: 'rc', keep: '0' })).toEqual({
      version: '2.6.0',
      channel: 'rc',
      keep: 0
    })
    expect(() => targetOpts({ channel: 'beta' })).toThrow(/unknown channel/)
    expect(() => targetOpts({ keep: '-1' })).toThrow(/invalid --keep/)
  })
})
