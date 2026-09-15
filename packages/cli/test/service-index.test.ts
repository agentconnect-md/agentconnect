import { afterEach, describe, it, expect, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  controllerFor,
  findUserScopeUnit,
  resolveServiceTarget,
  installService,
  listInstances,
  pickController,
  resolveController,
  retireUserScopeUnit,
  uninstallService
} from '../src/service/index.js'

const exec = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
  code: 0,
  stdout: '',
  stderr: ''
})
const deps = { root: '/tmp/r', home: '/tmp/h', uid: 501, exec }
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

const ACCOUNT = { user: 'agent', uid: 1000, gid: 1000, home: '/home/agent' }

/** A Linux target whose system-unit and polkit directories are temporary, so an
 *  install under test never touches /etc. */
function linuxScope() {
  return {
    platform: 'linux' as const,
    home: tmp('ac-home-'),
    systemUnitDir: tmp('ac-sys-'),
    polkitDir: tmp('ac-polkit-'),
    account: ACCOUNT,
    exec
  }
}

const opts = { execPath: '/usr/bin/node', includeRootEnv: true }

/** Lay down a legacy `~/.config/systemd/user` unit the way an older CLI would have. */
function writeUserUnit(home: string, label: string, root: string): string {
  const dir = join(home, '.config', 'systemd', 'user')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, label)
  writeFileSync(path, `[Service]\nExecStart=/usr/bin/node /x/index.js run --root ${root}\n`)
  return path
}

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
    const scope = linuxScope()
    const root = tmp('ac-root-')
    await installService({ root, instance: 'dev', ...scope }, opts)
    // The daemon's CP-commanded upgrade spawns `upgrade --root <root>` only.
    expect(resolveController({ root, ...scope }).label).toBe('agentconnect@dev.service')
  })

  it('drives a legacy user unit in its own scope, rather than reporting nothing installed', () => {
    const scope = linuxScope()
    const root = tmp('ac-root-')
    writeUserUnit(scope.home, 'agentconnect.service', root)
    const c = resolveController({ root, ...scope })
    // A host mid-migration must still be able to `status`/`down`/`uninstall` it.
    expect(c.isInstalled()).toBe(true)
    expect((c as unknown as { scope: string }).scope).toBe('user')
  })
})

describe('installService / uninstallService', () => {
  it('writes the unit plus the pointer, and removes both again', async () => {
    const scope = linuxScope()
    const root = tmp('ac-root-')
    const target = { root, instance: 'dev', ...scope }
    const unitPath = join(scope.systemUnitDir, 'agentconnect@dev.service')

    const c = await installService(target, opts)
    expect(c.label).toBe('agentconnect@dev.service')
    expect(existsSync(unitPath)).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'service.json'), 'utf8'))).toEqual({
      instance: 'dev',
      label: 'agentconnect@dev.service'
    })
    // Install enables the unit, so `up` only ever needs the polkit-granted `start`.
    expect(readFileSync(unitPath, 'utf8')).toContain('WantedBy=multi-user.target')
    expect(existsSync(join(scope.polkitDir, '49-agentconnect@dev.rules'))).toBe(true)

    await uninstallService(target)
    expect(existsSync(unitPath)).toBe(false)
    expect(existsSync(join(scope.polkitDir, '49-agentconnect@dev.rules'))).toBe(false)
    expect(existsSync(join(root, 'service.json'))).toBe(false)
  })

  it('keeps two instances on the same host independent', async () => {
    const scope = linuxScope()
    const [rootA, rootB] = [tmp('ac-root-'), tmp('ac-root-')]
    await installService({ root: rootA, ...scope }, opts)
    await installService({ root: rootB, instance: 'b', ...scope }, opts)

    expect(listInstances(scope)).toEqual([
      {
        label: 'agentconnect.service',
        root: rootA,
        unitPath: join(scope.systemUnitDir, 'agentconnect.service'),
        scope: 'system',
        user: ACCOUNT.user
      },
      {
        instance: 'b',
        label: 'agentconnect@b.service',
        root: rootB,
        unitPath: join(scope.systemUnitDir, 'agentconnect@b.service'),
        scope: 'system',
        user: ACCOUNT.user
      }
    ])

    // Removing the named instance leaves the default one installed.
    await uninstallService({ root: rootB, instance: 'b', ...scope })
    expect(listInstances(scope).map((u) => u.label)).toEqual(['agentconnect.service'])
  })
})

describe('legacy user-unit migration', () => {
  it('finds the user unit for this instance and retires it without root', async () => {
    const scope = linuxScope()
    const root = tmp('ac-root-')
    const path = writeUserUnit(scope.home, 'agentconnect@dev.service', root)
    const calls: string[][] = []
    const recording = async (_c: string, args: string[]) => {
      calls.push(args)
      return { code: 0, stdout: '', stderr: '' }
    }

    const found = findUserScopeUnit({ root, instance: 'dev', ...scope })
    expect(found?.unitPath).toBe(path)
    // The manager reports a different FragmentPath, so this label is not the file
    // we found — stopping it would retire a different account's live daemon.
    await retireUserScopeUnit(found!, { ...scope, exec: recording })
    expect(calls).toEqual([['--user', 'show', '-p', 'FragmentPath', '--value', 'agentconnect@dev.service']])
    expect(existsSync(path)).toBe(false)
  })

  it('stops the unit when the manager confirms it serves this very file', async () => {
    const scope = linuxScope()
    const root = tmp('ac-root-')
    const path = writeUserUnit(scope.home, 'agentconnect@dev.service', root)
    const calls: string[][] = []
    const confirming = async (_c: string, args: string[]) => {
      calls.push(args)
      return { code: 0, stdout: args.includes('FragmentPath') ? `${path}\n` : '', stderr: '' }
    }
    const found = findUserScopeUnit({ root, instance: 'dev', ...scope })
    await retireUserScopeUnit(found!, { ...scope, exec: confirming })
    expect(calls.map((a) => a.slice(0, 3))).toEqual([
      ['--user', 'show', '-p'],
      ['--user', 'disable', '--now'],
      ['--user', 'daemon-reload']
    ])
    expect(existsSync(path)).toBe(false)
  })

  it('refuses a system install while the user unit is still installed', async () => {
    const scope = linuxScope()
    const root = tmp('ac-root-')
    writeUserUnit(scope.home, 'agentconnect.service', root)
    // Reaching installService with one still on disk means someone ran the
    // command under sudo by hand, skipping the unelevated retirement step.
    await expect(installService({ root, ...scope }, opts)).rejects.toThrow(/WITHOUT sudo/)
  })
})

describe('named instance root resolution', () => {
  it('takes the root its installed unit drives, not the ~/.agentconnect-<name> default', async () => {
    const scope = linuxScope()
    const root = tmp('ac-root-')
    await installService({ root, instance: 'dev', ...scope }, opts)
    // Otherwise `--instance dev restart` would drive this unit while
    // `--instance dev chat` delegated to ~/.agentconnect-dev — two daemons.
    expect(
      resolveServiceTarget({ instance: 'dev', home: scope.home, platform: 'linux', systemUnitDir: scope.systemUnitDir })
    ).toEqual({
      root,
      instance: 'dev'
    })
  })

  it('falls back to the name-derived default when nothing is installed yet', () => {
    const home = tmp('ac-home-')
    const fakeUserHome = tmp('ac-userhome-')
    vi.stubEnv('HOME', fakeUserHome)
    vi.stubEnv('USERPROFILE', fakeUserHome) // what `homedir()` reads on Windows
    vi.stubEnv('AGENTCONNECT_ROOT', undefined)
    expect(resolveServiceTarget({ instance: 'dev', home, platform: 'linux', systemUnitDir: tmp('ac-sys-') })).toEqual({
      root: join(fakeUserHome, '.agentconnect-dev'),
      instance: 'dev'
    })
  })

  it('refuses to move an instance whose service is still running', async () => {
    const scope = linuxScope()
    const [oldRoot, newRoot] = [tmp('ac-root-'), tmp('ac-root-')]
    await installService({ root: oldRoot, instance: 'dev', ...scope }, opts)

    // Rewriting the unit would not move the RUNNING daemon off oldRoot.
    const activeExec = async (_cmd: string, args: string[]) => ({
      code: 0,
      stdout: args.includes('is-active') ? 'active\n' : '',
      stderr: ''
    })
    await expect(installService({ root: newRoot, instance: 'dev', ...scope, exec: activeExec }, opts)).rejects.toThrow(
      /is running against .* down` before moving this instance/
    )

    // The move is refused before anything is rewritten or forgotten.
    expect(listInstances(scope)[0]!.root).toBe(oldRoot)
    expect(existsSync(join(oldRoot, 'service.json'))).toBe(true)
  })

  it("moves a stopped instance to a new root and drops the abandoned root's pointer", async () => {
    const scope = linuxScope()
    const [oldRoot, newRoot] = [tmp('ac-root-'), tmp('ac-root-')]
    await installService({ root: oldRoot, instance: 'dev', ...scope }, opts)
    await installService({ root: newRoot, instance: 'dev', ...scope }, opts)

    expect(existsSync(join(oldRoot, 'service.json'))).toBe(false)
    expect(existsSync(join(newRoot, 'service.json'))).toBe(true)
    expect(listInstances(scope)).toEqual([
      {
        instance: 'dev',
        label: 'agentconnect@dev.service',
        root: newRoot,
        unitPath: join(scope.systemUnitDir, 'agentconnect@dev.service'),
        scope: 'system',
        user: ACCOUNT.user
      }
    ])
  })
})

describe('installService conflicts', () => {
  it('refuses a second unit on a root another instance already owns', async () => {
    const scope = linuxScope()
    const root = tmp('ac-root-')
    await installService({ root, ...scope }, opts)
    // Two units on one root would fight over its lock, sqlite and MCP socket.
    await expect(installService({ root, instance: 'dev', ...scope }, opts)).rejects.toThrow(
      /already belongs to agentconnect\.service/
    )
    expect(listInstances(scope).map((u) => u.label)).toEqual(['agentconnect.service'])
  })

  it('still re-installs the same instance in place (the legacy-unit migration path)', async () => {
    const scope = linuxScope()
    const root = tmp('ac-root-')
    await installService({ root, instance: 'dev', ...scope }, opts)
    await expect(installService({ root, instance: 'dev', ...scope }, opts)).resolves.toBeTruthy()
  })
})

describe('controllerFor', () => {
  it('takes the instance from the unit on disk, not from the root pointer', async () => {
    const scope = linuxScope()
    const root = tmp('ac-root-')
    await installService({ root, instance: 'dev', ...scope }, opts)
    const [unit] = listInstances(scope)
    expect(controllerFor(unit!, scope).label).toBe('agentconnect@dev.service')
  })
})

describe('listInstances', () => {
  it('is empty on a platform with no service support', () => {
    expect(listInstances({ home: tmp('ac-home-'), platform: 'win32' })).toEqual([])
  })
})
