import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPlist, LaunchdController } from '../src/service/launchd.js'
import type { Exec, ExecResult } from '../src/service/types.js'

function fakeExec(): { exec: Exec; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args })
    return { code: 0, stdout: '', stderr: '' } as ExecResult
  }
  return { exec, calls }
}

const home = () => mkdtempSync(join(tmpdir(), 'ac-home-'))
const root = () => mkdtempSync(join(tmpdir(), 'ac-root-'))

describe('buildPlist', () => {
  it('runs the daemon through <root>/current, always marks the supervisor, omits AGENTCONNECT_ROOT when default', () => {
    const plist = buildPlist({
      label: 'md.agentconnect.daemon',
      execPath: '/usr/bin/node',
      logPath: '/home/u/.agentconnect/logs/daemon.log',
      root: '/home/u/.agentconnect',
      includeRootEnv: false
    })
    expect(plist).toContain('<string>md.agentconnect.daemon</string>')
    expect(plist).toContain('<string>/usr/bin/node</string>')
    // Entry is the stable current-symlink path, not a versioned dist.
    expect(plist).toContain('<string>/home/u/.agentconnect/current/dist/index.js</string>')
    expect(plist).toContain('<string>run</string>')
    expect(plist).toContain('<string>/home/u/.agentconnect/logs/daemon.log</string>')
    // Supervisor marker is always present so the daemon accepts CP restart/upgrade.
    expect(plist).toContain('<key>AGENTCONNECT_SUPERVISOR</key>')
    expect(plist).toContain('<string>service</string>')
    expect(plist).not.toContain('AGENTCONNECT_ROOT')
  })

  it('runs the CLI run shell when a cliEntry is pinned', () => {
    const plist = buildPlist({
      label: 'md.agentconnect.daemon',
      execPath: '/usr/bin/node',
      logPath: '/home/u/.agentconnect/logs/daemon.log',
      root: '/home/u/.agentconnect',
      includeRootEnv: false,
      cliEntry: '/opt/homebrew/lib/node_modules/agentconnect/dist/index.js'
    })
    expect(plist).toContain('<string>/opt/homebrew/lib/node_modules/agentconnect/dist/index.js</string>')
    expect(plist).not.toContain('current/dist/index.js')
  })

  it('bakes the installing shell PATH into EnvironmentVariables, XML-escaped', () => {
    const plist = buildPlist({
      label: 'md.agentconnect.daemon',
      execPath: '/usr/bin/node',
      logPath: '/home/u/.agentconnect/logs/daemon.log',
      root: '/home/u/.agentconnect',
      includeRootEnv: false,
      envPath: '/opt/homebrew/bin:/a&b/bin'
    })
    expect(plist).toContain('<key>PATH</key>')
    expect(plist).toContain('<string>/opt/homebrew/bin:/a&amp;b/bin</string>')
  })

  it('omits the PATH entry when no envPath is supplied', () => {
    const plist = buildPlist({
      label: 'md.agentconnect.daemon',
      execPath: '/usr/bin/node',
      logPath: '/home/u/.agentconnect/logs/daemon.log',
      root: '/home/u/.agentconnect',
      includeRootEnv: false
    })
    expect(plist).not.toContain('<key>PATH</key>')
  })

  it('includes AGENTCONNECT_ROOT when non-default', () => {
    const plist = buildPlist({
      label: 'md.agentconnect.daemon',
      execPath: '/usr/bin/node',
      logPath: '/custom/logs/daemon.log',
      root: '/custom',
      includeRootEnv: true
    })
    expect(plist).toContain('AGENTCONNECT_ROOT')
    expect(plist).toContain('<string>/custom</string>')
    expect(plist).toContain('<string>/custom/current/dist/index.js</string>')
  })
})

describe('LaunchdController', () => {
  it('install writes the plist; isInstalled flips true', async () => {
    const h = home()
    const { exec } = fakeExec()
    const c = new LaunchdController({ root: root(), home: h, uid: 501, exec })
    expect(c.isInstalled()).toBe(false)
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: false })
    const plistPath = join(h, 'Library', 'LaunchAgents', 'md.agentconnect.daemon.plist')
    expect(existsSync(plistPath)).toBe(true)
    expect(readFileSync(plistPath, 'utf8')).toContain('<string>run</string>')
    expect(c.isInstalled()).toBe(true)
  })

  it('up bootstraps the plist into the gui domain', async () => {
    const h = home()
    const { exec, calls } = fakeExec()
    const c = new LaunchdController({ root: root(), home: h, uid: 501, exec })
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: false })
    await c.up()
    const bootstrap = calls.find((k) => k.cmd === 'launchctl' && k.args[0] === 'bootstrap' && k.args[1] === 'gui/501')
    expect(bootstrap).toBeDefined()
    expect(bootstrap?.args[2]).toBe(join(h, 'Library', 'LaunchAgents', 'md.agentconnect.daemon.plist'))
    expect(bootstrap?.args[2]!.endsWith('Library/LaunchAgents/md.agentconnect.daemon.plist')).toBe(true)
  })

  it('down boots the label out of the gui domain', async () => {
    const { exec, calls } = fakeExec()
    const c = new LaunchdController({ root: root(), home: home(), uid: 501, exec })
    await c.down()
    expect(
      calls.some(
        (k) => k.cmd === 'launchctl' && k.args[0] === 'bootout' && k.args[1] === 'gui/501/md.agentconnect.daemon'
      )
    ).toBe(true)
  })
})
