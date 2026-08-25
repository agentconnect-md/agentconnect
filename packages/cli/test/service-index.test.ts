import { afterEach, describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  controllerFor,
  resolveServiceTarget,
  installService,
  listInstances,
  pickController,
  resolveController,
  uninstallService
} from '../src/service/index.js'

const exec = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
  code: 0,
  stdout: '',
  stderr: ''
})
const deps = { root: '/tmp/r', home: '/tmp/h', uid: 501, exec }
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

afterEach(() => vi.unstubAllEnvs())

describe('pickController', () => {
  it('returns the launchd controller on darwin', () => {
    expect(pickController('darwin', deps).label).toBe('md.agentconnect.daemon')
  })
  it('returns the systemd controller on linux', () => {
    expect(pickController('linux', deps).label).toBe('agentconnect.service')
  })
  it('throws an actionable error on win32', () => {
    expect(() => pickController('win32', deps)).toThrow(/not supported on win32/i)
  })
  it("names a named instance's unit", () => {
    expect(pickController('linux', { ...deps, instance: 'dev' }).label).toBe('agentconnect@dev.service')
    expect(pickController('darwin', { ...deps, instance: 'dev' }).label).toBe('md.agentconnect.daemon.dev')
  })
})

describe('resolveController', () => {
  it('builds a controller for the requested platform', () => {
    const c = resolveController({ root: '/tmp/r', platform: 'linux' })
    expect(c.label).toBe('agentconnect.service')
  })

  it('addresses the instance recorded in the root when given only --root', async () => {
    const root = tmp('ac-root-')
    const home = tmp('ac-home-')
    await installService(
      { root, instance: 'dev', platform: 'linux', home, exec },
      {
        execPath: '/usr/bin/node',
        includeRootEnv: true
      }
    )
    // The daemon's CP-commanded upgrade spawns `upgrade --root <root>` only.
    expect(resolveController({ root, platform: 'linux', home }).label).toBe('agentconnect@dev.service')
  })
})

describe('installService / uninstallService', () => {
  it('writes the unit plus the pointer, and removes both again', async () => {
    const root = tmp('ac-root-')
    const home = tmp('ac-home-')
    const target = { root, instance: 'dev', platform: 'linux' as const, home, exec }

    const c = await installService(target, { execPath: '/usr/bin/node', includeRootEnv: true })
    expect(c.label).toBe('agentconnect@dev.service')
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'agentconnect@dev.service'))).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'service.json'), 'utf8'))).toEqual({
      instance: 'dev',
      label: 'agentconnect@dev.service'
    })

    await uninstallService(target)
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'agentconnect@dev.service'))).toBe(false)
    expect(existsSync(join(root, 'service.json'))).toBe(false)
  })

  it('keeps two instances on the same host independent', async () => {
    const home = tmp('ac-home-')
    const [rootA, rootB] = [tmp('ac-root-'), tmp('ac-root-')]
    const opts = { execPath: '/usr/bin/node', includeRootEnv: true }
    await installService({ root: rootA, platform: 'linux', home, exec }, opts)
    await installService({ root: rootB, instance: 'b', platform: 'linux', home, exec }, opts)

    expect(listInstances({ home, platform: 'linux' })).toEqual([
      {
        label: 'agentconnect.service',
        root: rootA,
        unitPath: join(home, '.config', 'systemd', 'user', 'agentconnect.service')
      },
      {
        instance: 'b',
        label: 'agentconnect@b.service',
        root: rootB,
        unitPath: join(home, '.config', 'systemd', 'user', 'agentconnect@b.service')
      }
    ])

    // Removing the named instance leaves the default one installed.
    await uninstallService({ root: rootB, instance: 'b', platform: 'linux', home, exec })
    expect(listInstances({ home, platform: 'linux' }).map((u) => u.label)).toEqual(['agentconnect.service'])
  })
})

describe('named instance root resolution', () => {
  it('takes the root its installed unit drives, not the ~/.agentconnect-<name> default', async () => {
    const home = tmp('ac-home-')
    const root = tmp('ac-root-')
    await installService(
      { root, instance: 'dev', platform: 'linux', home, exec },
      {
        execPath: '/usr/bin/node',
        includeRootEnv: true
      }
    )
    // Otherwise `--instance dev restart` would drive this unit while
    // `--instance dev chat` delegated to ~/.agentconnect-dev — two daemons.
    expect(resolveServiceTarget({ instance: 'dev', home, platform: 'linux' })).toEqual({ root, instance: 'dev' })
  })

  it('falls back to the name-derived default when nothing is installed yet', () => {
    const home = tmp('ac-home-')
    const fakeUserHome = tmp('ac-userhome-')
    vi.stubEnv('HOME', fakeUserHome)
    vi.stubEnv('AGENTCONNECT_ROOT', undefined)
    expect(resolveServiceTarget({ instance: 'dev', home, platform: 'linux' })).toEqual({
      root: join(fakeUserHome, '.agentconnect-dev'),
      instance: 'dev'
    })
  })

  it('refuses to move an instance whose service is still running', async () => {
    const home = tmp('ac-home-')
    const [oldRoot, newRoot] = [tmp('ac-root-'), tmp('ac-root-')]
    const opts = { execPath: '/usr/bin/node', includeRootEnv: true }
    await installService({ root: oldRoot, instance: 'dev', platform: 'linux', home, exec }, opts)

    // Rewriting the unit would not move the RUNNING daemon off oldRoot.
    const activeExec = async (_cmd: string, args: string[]) => ({
      code: 0,
      stdout: args.includes('is-active') ? 'active\n' : '',
      stderr: ''
    })
    await expect(
      installService({ root: newRoot, instance: 'dev', platform: 'linux', home, exec: activeExec }, opts)
    ).rejects.toThrow(/is running against .* down` before moving this instance/)

    // The move is refused before anything is rewritten or forgotten.
    expect(listInstances({ home, platform: 'linux' })[0]!.root).toBe(oldRoot)
    expect(existsSync(join(oldRoot, 'service.json'))).toBe(true)
  })

  it("moves a stopped instance to a new root and drops the abandoned root's pointer", async () => {
    const home = tmp('ac-home-')
    const [oldRoot, newRoot] = [tmp('ac-root-'), tmp('ac-root-')]
    const opts = { execPath: '/usr/bin/node', includeRootEnv: true }
    await installService({ root: oldRoot, instance: 'dev', platform: 'linux', home, exec }, opts)
    await installService({ root: newRoot, instance: 'dev', platform: 'linux', home, exec }, opts)

    expect(existsSync(join(oldRoot, 'service.json'))).toBe(false)
    expect(existsSync(join(newRoot, 'service.json'))).toBe(true)
    expect(listInstances({ home, platform: 'linux' })).toEqual([
      {
        instance: 'dev',
        label: 'agentconnect@dev.service',
        root: newRoot,
        unitPath: join(home, '.config', 'systemd', 'user', 'agentconnect@dev.service')
      }
    ])
  })
})

describe('installService conflicts', () => {
  it('refuses a second unit on a root another instance already owns', async () => {
    const home = tmp('ac-home-')
    const root = tmp('ac-root-')
    const opts = { execPath: '/usr/bin/node', includeRootEnv: true }
    await installService({ root, platform: 'linux', home, exec }, opts)
    // Two units on one root would fight over its lock, sqlite and MCP socket.
    await expect(installService({ root, instance: 'dev', platform: 'linux', home, exec }, opts)).rejects.toThrow(
      /already belongs to agentconnect\.service/
    )
    expect(listInstances({ home, platform: 'linux' }).map((u) => u.label)).toEqual(['agentconnect.service'])
  })

  it('still re-installs the same instance in place (the legacy-unit migration path)', async () => {
    const home = tmp('ac-home-')
    const root = tmp('ac-root-')
    const opts = { execPath: '/usr/bin/node', includeRootEnv: true }
    await installService({ root, instance: 'dev', platform: 'linux', home, exec }, opts)
    await expect(installService({ root, instance: 'dev', platform: 'linux', home, exec }, opts)).resolves.toBeTruthy()
  })
})

describe('controllerFor', () => {
  it('takes the instance from the unit on disk, not from the root pointer', async () => {
    const home = tmp('ac-home-')
    const root = tmp('ac-root-')
    await installService(
      { root, instance: 'dev', platform: 'linux', home, exec },
      {
        execPath: '/usr/bin/node',
        includeRootEnv: true
      }
    )
    const [unit] = listInstances({ home, platform: 'linux' })
    expect(controllerFor(unit!, { platform: 'linux', home, exec }).label).toBe('agentconnect@dev.service')
  })
})

describe('listInstances', () => {
  it('is empty on a platform with no service support', () => {
    expect(listInstances({ home: tmp('ac-home-'), platform: 'win32' })).toEqual([])
  })
})
