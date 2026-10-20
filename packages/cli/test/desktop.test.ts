import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  desktopArgv,
  desktopCandidates,
  desktopDataDir,
  resolveDesktopLaunch,
  type DesktopHost
} from '../src/desktop.js'
import { classifyInvocation } from '../src/route.js'

const host = (over: Partial<DesktopHost> = {}): DesktopHost => ({
  env: {},
  platform: 'linux',
  home: '/home/ada',
  exists: () => false,
  ...over
})

describe('desktop routing', () => {
  it('routes desktop to the desktop daemon, never to the agent daemon', () => {
    expect(classifyInvocation(['desktop', 'doctor'])).toBe('desktop')
    expect(classifyInvocation(['--root', '/x', 'desktop', 'setup'])).toBe('desktop')
    expect(classifyInvocation(['desktop'])).toBe('desktop')
  })

  it('does not take a desktop token that is an option value or a later argument', () => {
    expect(classifyInvocation(['--root', 'desktop', 'chat'])).toBe('delegate')
    expect(classifyInvocation(['chat', 'desktop'])).toBe('delegate')
  })
})

describe('desktopArgv', () => {
  it('forwards everything after desktop verbatim', () => {
    expect(desktopArgv(['desktop', 'setup', '--host', '0.0.0.0', '--port', '7690', '--no-service'])).toEqual([
      'setup',
      '--host',
      '0.0.0.0',
      '--port',
      '7690',
      '--no-service'
    ])
    expect(desktopArgv(['desktop', 'service', 'restart'])).toEqual(['service', 'restart'])
    expect(desktopArgv(['desktop', '--help'])).toEqual(['--help'])
    expect(desktopArgv(['desktop'])).toEqual([])
  })

  it('keeps CLI options given before desktop with the CLI', () => {
    expect(desktopArgv(['--root', '/x', 'desktop', 'doctor', '--json'])).toEqual(['doctor', '--json'])
    expect(desktopArgv(['--root', 'desktop', 'desktop', 'pause'])).toEqual(['pause'])
    expect(desktopArgv(['--', 'desktop', 'resume'])).toEqual(['resume'])
  })

  it('rejects an invocation that is not a desktop one', () => {
    expect(() => desktopArgv(['chat', 'desktop'])).toThrow(/not a desktop invocation/)
  })
})

describe('resolveDesktopLaunch', () => {
  it('runs the installed bundle under this node', () => {
    const bundle = join('/home/ada', '.agentconnect', 'desktop', 'app', 'agentconnect-desktop.mjs')
    const launch = resolveDesktopLaunch(['doctor'], host({ exists: (p) => p === bundle }), '/usr/bin/node')
    expect(launch).toEqual({ command: '/usr/bin/node', args: [bundle, 'doctor'] })
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
    expect(() => resolveDesktopLaunch(['doctor'], host())).toThrow(/not installed.*agentconnect-desktop\.mjs/)
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

describe('agentconnect desktop (end to end)', () => {
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

  it('forwards the arguments after desktop and propagates the exit code', () => {
    const ok = cli(['--root', dir, 'desktop', 'setup', '--host', '0.0.0.0', '--no-service'])
    expect(ok.stderr).toBe('')
    const seen = JSON.parse(ok.stdout) as { argv: string[]; self: string }
    expect(seen.argv).toEqual(['setup', '--host', '0.0.0.0', '--no-service'])
    expect(seen.self).toMatch(/ desktop$/)
    expect(ok.status).toBe(0)
    const failed = cli(['desktop', 'doctor'], { FAKE_DESKTOP_EXIT: '1' })
    expect(JSON.parse(failed.stdout).argv).toEqual(['doctor'])
    expect(failed.status).toBe(1)
  }, 30_000)
})
