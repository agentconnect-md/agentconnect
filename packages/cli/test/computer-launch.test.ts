import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  computerArgv,
  desktopCandidates,
  desktopDataDir,
  resolveDesktopLaunch,
  type DesktopHost
} from '../src/computer/launch.js'
import { classifyInvocation } from '../src/route.js'

const host = (over: Partial<DesktopHost> = {}): DesktopHost => ({
  env: {},
  platform: 'linux',
  home: '/home/ada',
  exists: () => false,
  ...over
})

describe('computer routing', () => {
  it('routes computer and its desktop alias to the computer daemon, never to the agent daemon', () => {
    expect(classifyInvocation(['computer', 'doctor'])).toBe('computer')
    expect(classifyInvocation(['desktop', 'doctor'])).toBe('computer')
    expect(classifyInvocation(['--root', '/x', 'computer', 'setup'])).toBe('computer')
    expect(classifyInvocation(['desktop'])).toBe('computer')
  })

  it('does not take a desktop token that is an option value or a later argument', () => {
    expect(classifyInvocation(['--root', 'desktop', 'chat'])).toBe('delegate')
    expect(classifyInvocation(['chat', 'desktop'])).toBe('delegate')
  })
})

describe('computerArgv', () => {
  it('forwards everything after desktop verbatim', () => {
    expect(computerArgv(['desktop', 'setup', '--host', '0.0.0.0', '--port', '7690', '--no-service'])).toEqual([
      'setup',
      '--host',
      '0.0.0.0',
      '--port',
      '7690',
      '--no-service'
    ])
    expect(computerArgv(['desktop', 'service', 'restart'])).toEqual(['service', 'restart'])
    expect(computerArgv(['desktop', '--help'])).toEqual(['--help'])
    expect(computerArgv(['desktop'])).toEqual([])
  })

  it('keeps CLI options given before desktop with the CLI', () => {
    expect(computerArgv(['--root', '/x', 'desktop', 'doctor', '--json'])).toEqual(['doctor', '--json'])
    expect(computerArgv(['--root', 'desktop', 'desktop', 'pause'])).toEqual(['pause'])
    expect(computerArgv(['--', 'desktop', 'resume'])).toEqual(['resume'])
  })

  it('rejects an invocation that is not a desktop one', () => {
    expect(() => computerArgv(['chat', 'desktop'])).toThrow(/not a computer invocation/)
    expect(computerArgv(['computer', 'install', '--register', 't'])).toEqual(['install', '--register', 't'])
  })
})

describe('resolveDesktopLaunch', () => {
  it('runs the legacy installer bundle under this node', () => {
    const bundle = join('/home/ada', '.agentconnect', 'desktop', 'app', 'agentconnect-desktop.mjs')
    const launch = resolveDesktopLaunch(['doctor'], host({ exists: (p: string) => p === bundle }), '/usr/bin/node')
    expect(launch).toEqual({ command: '/usr/bin/node', args: [bundle, 'doctor'] })
  })

  it('prefers the version store and names its current entry for the service', () => {
    const store = join('/home/ada', '.agentconnect', 'desktop', 'current', 'dist', 'agentconnect-desktop.mjs')
    const launch = resolveDesktopLaunch(['setup'], host({ exists: () => true }), '/usr/bin/node')
    expect(launch).toEqual({ command: '/usr/bin/node', args: [store, 'setup'], serviceEntry: store })
  })

  it('prefers the macOS app, which owns the grants, and runs its binary directly', () => {
    const app = join(
      '/Users/ada',
      'Applications',
      'AgentConnect Desktop.app',
      'Contents',
      'MacOS',
      'agentconnect-desktop'
    )
    const h = host({ platform: 'darwin', home: '/Users/ada', exists: () => true })
    expect(resolveDesktopLaunch(['service', 'install'], h, '/usr/bin/node')).toEqual({
      command: app,
      args: ['service', 'install']
    })
    expect(desktopCandidates(h)).toEqual([
      app,
      join('/Applications', 'AgentConnect Desktop.app', 'Contents', 'MacOS', 'agentconnect-desktop'),
      join('/Users/ada', '.agentconnect', 'desktop', 'current', 'dist', 'agentconnect-desktop.mjs'),
      join('/Users/ada', '.agentconnect', 'desktop', 'app', 'agentconnect-desktop.mjs')
    ])
  })

  it('honors AGENTCONNECT_DESKTOP_ENTRY and fails loudly when it is missing', () => {
    const env = { AGENTCONNECT_DESKTOP_ENTRY: '/repo/packages/desktop/bundle/agentconnect-desktop.mjs' }
    expect(resolveDesktopLaunch(['run'], host({ env, exists: () => true }), 'node')).toEqual({
      command: 'node',
      args: [env.AGENTCONNECT_DESKTOP_ENTRY, 'run']
    })
    expect(() => resolveDesktopLaunch(['run'], host({ env }), 'node')).toThrow(/AGENTCONNECT_DESKTOP_ENTRY/)
  })

  it('names every place it looked when nothing is installed', () => {
    expect(() => resolveDesktopLaunch(['doctor'], host())).toThrow(
      /not installed.*current.*agentconnect-desktop\.mjs.*agentconnect computer install/
    )
  })

  it('follows the desktop daemon data dir', () => {
    expect(desktopDataDir(host({ env: { AGENTCONNECT_DESKTOP_HOME: '/srv/desk' } }))).toBe('/srv/desk')
    expect(desktopDataDir(host({ platform: 'win32', home: 'C:\\Users\\ada', env: {} }))).toBe(
      win32.join('C:\\Users\\ada', 'AppData', 'Local', 'AgentConnect', 'desktop')
    )
    expect(desktopDataDir(host({ platform: 'win32', env: { LOCALAPPDATA: 'D:\\Local' } }))).toBe(
      win32.join('D:\\Local', 'AgentConnect', 'desktop')
    )
  })
})

describe('agentconnect computer (end to end)', () => {
  const pkg = fileURLToPath(new URL('..', import.meta.url))
  let dir = ''
  let entry = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ac-desktop-'))
    entry = join(dir, 'fake-desktop.mjs')
    writeFileSync(
      entry,
      'console.log(JSON.stringify({ argv: process.argv.slice(2), self: process.env.AGENTCONNECT_DESKTOP_COMMAND }))\n' +
        'process.exit(Number(process.env.FAKE_DESKTOP_EXIT ?? 0))\n'
    )
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(
      process.execPath,
      ['--conditions=development', '--import', 'tsx', join(pkg, 'src', 'index.ts'), ...args],
      {
        cwd: pkg,
        encoding: 'utf8',
        env: { ...process.env, AGENTCONNECT_DESKTOP_ENTRY: entry, AGENTCONNECT_ROOT: dir, ...env }
      }
    )

  it('forwards the arguments after computer (or desktop) and propagates the exit code', () => {
    const ok = cli(['--root', dir, 'computer', 'setup', '--host', '0.0.0.0', '--no-service'])
    expect(ok.stderr).toBe('')
    const seen = JSON.parse(ok.stdout) as { argv: string[]; self: string }
    expect(seen.argv).toEqual(['setup', '--host', '0.0.0.0', '--no-service'])
    expect(seen.self).toMatch(/ computer$/)
    expect(JSON.parse(cli(['desktop', 'pause']).stdout).argv).toEqual(['pause'])
    expect(JSON.parse(cli(['computer', 'restart']).stdout).argv).toEqual(['service', 'restart'])
    expect(ok.status).toBe(0)
    const failed = cli(['desktop', 'doctor'], { FAKE_DESKTOP_EXIT: '1' })
    // doctor names the version first, then hands over to the daemon.
    const [header, , report] = failed.stdout.trim().split('\n')
    expect(header).toMatch(/^computer daemon: not from the version store — .*fake-desktop\.mjs$/)
    expect(JSON.parse(report!).argv).toEqual(['doctor'])
    expect(failed.status).toBe(1)
  }, 30_000)
})
