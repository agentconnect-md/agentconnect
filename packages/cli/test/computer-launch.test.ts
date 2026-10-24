import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  computerAppRunner,
  computerArgv,
  computerCandidates,
  computerDataDir,
  resolveComputerLaunch,
  type ComputerHost
} from '../src/computer/launch.js'
import { serviceArgs } from '../src/computer/commands.js'
import { classifyInvocation } from '../src/route.js'

const host = (over: Partial<ComputerHost> = {}): ComputerHost => ({
  env: {},
  platform: 'linux',
  home: '/home/ada',
  exists: () => false,
  ...over
})

describe('computer routing', () => {
  it('routes computer to the computer daemon, never to the agent daemon', () => {
    expect(classifyInvocation(['computer', 'doctor'])).toBe('computer')
    expect(classifyInvocation(['--root', '/x', 'computer', 'setup'])).toBe('computer')
    expect(classifyInvocation(['computer'])).toBe('computer')
  })

  it('does not take a computer token that is an option value or a later argument', () => {
    expect(classifyInvocation(['--root', 'computer', 'chat'])).toBe('delegate')
    expect(classifyInvocation(['chat', 'computer'])).toBe('delegate')
  })

  it('no longer routes the retired desktop alias to the computer daemon', () => {
    expect(classifyInvocation(['desktop', 'doctor'])).toBe('delegate')
  })
})

describe('serviceArgs', () => {
  it("maps start/stop/restart to the daemon's service command off Windows", () => {
    for (const platform of ['linux', 'darwin'] as const)
      for (const action of ['start', 'stop', 'restart'])
        expect(serviceArgs(action, platform)).toEqual(['service', action])
  })

  it('starts the Run-key entry on Windows and rejects stop/restart there instead of a misleading service error', () => {
    expect(serviceArgs('start', 'win32')).toEqual(['autostart', 'start'])
    expect(() => serviceArgs('stop', 'win32')).toThrow(/stop is not supported on Windows yet/)
    expect(() => serviceArgs('restart', 'win32')).toThrow(/restart is not supported on Windows yet/)
  })
})

describe('computerArgv', () => {
  it('forwards everything after computer verbatim', () => {
    expect(computerArgv(['computer', 'setup', '--host', '0.0.0.0', '--port', '7690', '--no-service'])).toEqual([
      'setup',
      '--host',
      '0.0.0.0',
      '--port',
      '7690',
      '--no-service'
    ])
    expect(computerArgv(['computer', 'service', 'restart'])).toEqual(['service', 'restart'])
    expect(computerArgv(['computer', '--help'])).toEqual(['--help'])
    expect(computerArgv(['computer'])).toEqual([])
  })

  it('keeps CLI options given before computer with the CLI', () => {
    expect(computerArgv(['--root', '/x', 'computer', 'doctor', '--json'])).toEqual(['doctor', '--json'])
    expect(computerArgv(['--root', 'computer', 'computer', 'pause'])).toEqual(['pause'])
    expect(computerArgv(['--', 'computer', 'resume'])).toEqual(['resume'])
  })

  it('rejects an invocation that is not a computer one', () => {
    expect(() => computerArgv(['chat', 'computer'])).toThrow(/not a computer invocation/)
    expect(() => computerArgv(['desktop', 'doctor'])).toThrow(/not a computer invocation/)
    expect(computerArgv(['computer', 'install', '--register', 't'])).toEqual(['install', '--register', 't'])
  })
})

describe('resolveComputerLaunch', () => {
  it('runs the legacy installer bundle under this node', () => {
    const bundle = join('/home/ada', '.agentconnect', 'computer', 'app', 'agentconnect-computer.mjs')
    const launch = resolveComputerLaunch(['doctor'], host({ exists: (p: string) => p === bundle }), '/usr/bin/node')
    expect(launch).toEqual({ command: '/usr/bin/node', args: [bundle, 'doctor'] })
  })

  it('prefers the version store and names its current entry for the service', () => {
    const store = join('/home/ada', '.agentconnect', 'computer', 'current', 'dist', 'agentconnect-computer.mjs')
    const launch = resolveComputerLaunch(['setup'], host({ exists: () => true }), '/usr/bin/node')
    expect(launch).toEqual({ command: '/usr/bin/node', args: [store, 'setup'], serviceEntry: store })
  })

  it('runs the store entry inside the macOS app, whose Node runtime holds the grants', () => {
    const app = join(
      '/Users/ada',
      'Applications',
      'AgentConnect Computer.app',
      'Contents',
      'MacOS',
      'agentconnect-computer'
    )
    const store = join('/Users/ada', '.agentconnect', 'computer', 'current', 'dist', 'agentconnect-computer.mjs')
    const h = host({ platform: 'darwin', home: '/Users/ada', exists: () => true })
    expect(resolveComputerLaunch(['service', 'install'], h, '/usr/bin/node')).toEqual({
      command: app,
      args: [store, 'service', 'install'],
      serviceEntry: store
    })
    expect(computerAppRunner(h)).toBe(app)
    expect(computerCandidates(h)).toEqual([
      store,
      join('/Users/ada', '.agentconnect', 'computer', 'app', 'agentconnect-computer.mjs')
    ])
  })

  it('falls back to this node on a Mac without the app, and never uses an app off macOS', () => {
    const store = join('/Users/ada', '.agentconnect', 'computer', 'current', 'dist', 'agentconnect-computer.mjs')
    const mac = host({ platform: 'darwin', home: '/Users/ada', exists: (p: string) => p === store })
    expect(resolveComputerLaunch(['doctor'], mac, '/usr/bin/node').command).toBe('/usr/bin/node')
    expect(computerAppRunner(host({ exists: () => true }))).toBeUndefined()
  })

  it('honors AGENTCONNECT_COMPUTER_ENTRY and fails loudly when it is missing', () => {
    const env = { AGENTCONNECT_COMPUTER_ENTRY: '/repo/packages/computer/bundle/agentconnect-computer.mjs' }
    expect(resolveComputerLaunch(['run'], host({ env, exists: () => true }), 'node')).toEqual({
      command: 'node',
      args: [env.AGENTCONNECT_COMPUTER_ENTRY, 'run']
    })
    expect(() => resolveComputerLaunch(['run'], host({ env }), 'node')).toThrow(/AGENTCONNECT_COMPUTER_ENTRY/)
  })

  it('names every place it looked when nothing is installed', () => {
    expect(() => resolveComputerLaunch(['doctor'], host())).toThrow(
      /not installed.*current.*agentconnect-computer\.mjs.*agentconnect computer install/
    )
  })

  it('follows the computer daemon data dir', () => {
    expect(computerDataDir(host({ env: { AGENTCONNECT_COMPUTER_HOME: '/srv/desk' } }))).toBe('/srv/desk')
    expect(computerDataDir(host({ platform: 'win32', home: 'C:\\Users\\ada', env: {} }))).toBe(
      win32.join('C:\\Users\\ada', 'AppData', 'Local', 'AgentConnect', 'computer')
    )
    expect(computerDataDir(host({ platform: 'win32', env: { LOCALAPPDATA: 'D:\\Local' } }))).toBe(
      win32.join('D:\\Local', 'AgentConnect', 'computer')
    )
  })
})

describe('agentconnect computer (end to end)', () => {
  const pkg = fileURLToPath(new URL('..', import.meta.url))
  let dir = ''
  let entry = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ac-computer-'))
    entry = join(dir, 'fake-computer.mjs')
    writeFileSync(
      entry,
      'console.log(JSON.stringify({ argv: process.argv.slice(2), self: process.env.AGENTCONNECT_COMPUTER_COMMAND }))\n' +
        'process.exit(Number(process.env.FAKE_COMPUTER_EXIT ?? 0))\n'
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
        env: { ...process.env, AGENTCONNECT_COMPUTER_ENTRY: entry, AGENTCONNECT_ROOT: dir, ...env }
      }
    )

  it('forwards the arguments after computer and propagates the exit code', () => {
    const ok = cli(['--root', dir, 'computer', 'setup', '--host', '0.0.0.0', '--no-service'])
    expect(ok.stderr).toBe('')
    const seen = JSON.parse(ok.stdout) as { argv: string[]; self: string }
    expect(seen.argv).toEqual(['setup', '--host', '0.0.0.0', '--no-service'])
    expect(seen.self).toMatch(/ computer$/)
    expect(JSON.parse(cli(['computer', 'pause']).stdout).argv).toEqual(['pause'])
    const restart = cli(['computer', 'restart'])
    if (process.platform === 'win32') {
      expect(restart.status).toBe(1)
      expect(restart.stderr).toMatch(/restart is not supported on Windows yet/)
    } else expect(JSON.parse(restart.stdout).argv).toEqual(['service', 'restart'])
    expect(ok.status).toBe(0)
    const failed = cli(['computer', 'doctor'], { FAKE_COMPUTER_EXIT: '1' })
    // doctor names the version first, then hands over to the daemon.
    const [header, , report] = failed.stdout.trim().split('\n')
    expect(header).toMatch(/^computer daemon: not from the version store — .*fake-computer\.mjs$/)
    expect(JSON.parse(report!).argv).toEqual(['doctor'])
    expect(failed.status).toBe(1)
  }, 30_000)
})
