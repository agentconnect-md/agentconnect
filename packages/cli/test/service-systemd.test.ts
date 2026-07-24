import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystemdUnit, SystemdController } from '../src/service/systemd.js'
import type { Exec } from '../src/service/types.js'

function fakeExec(): { exec: Exec; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args })
    return { code: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

const home = () => mkdtempSync(join(tmpdir(), 'ac-home-'))
const root = () => mkdtempSync(join(tmpdir(), 'ac-root-'))

describe('buildSystemdUnit', () => {
  it('runs the daemon through <root>/current, always marks the supervisor, Restart=always', () => {
    const unit = buildSystemdUnit({
      execPath: '/usr/bin/node',
      root: '/home/u/.agentconnect',
      includeRootEnv: false
    })
    // ExecStart runs the stable current-symlink path, not a versioned dist.
    expect(unit).toContain('ExecStart=/usr/bin/node /home/u/.agentconnect/current/dist/index.js run')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('Environment=AGENTCONNECT_SUPERVISOR=service')
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).not.toContain('AGENTCONNECT_ROOT')
  })

  it('adds Environment=AGENTCONNECT_ROOT when non-default', () => {
    const unit = buildSystemdUnit({
      execPath: '/usr/bin/node',
      root: '/custom',
      includeRootEnv: true
    })
    expect(unit).toContain('Environment=AGENTCONNECT_ROOT=/custom')
    expect(unit).toContain('ExecStart=/usr/bin/node /custom/current/dist/index.js run')
  })
})

describe('SystemdController', () => {
  it('install writes the unit and daemon-reloads', async () => {
    const h = home()
    const { exec, calls } = fakeExec()
    const c = new SystemdController({ root: root(), home: h, uid: 1000, exec })
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: false })
    const unitPath = join(h, '.config', 'systemd', 'user', 'agentconnect.service')
    expect(existsSync(unitPath)).toBe(true)
    expect(readFileSync(unitPath, 'utf8')).toContain('ExecStart=')
    expect(calls.some((k) => k.cmd === 'systemctl' && k.args.join(' ') === '--user daemon-reload')).toBe(true)
  })

  it('up enables --now', async () => {
    const { exec, calls } = fakeExec()
    const c = new SystemdController({ root: root(), home: home(), uid: 1000, exec })
    await c.up()
    expect(calls.some((k) => k.args.join(' ') === '--user enable --now agentconnect.service')).toBe(true)
  })

  it('down disables --now', async () => {
    const { exec, calls } = fakeExec()
    const c = new SystemdController({ root: root(), home: home(), uid: 1000, exec })
    await c.down()
    expect(calls.some((k) => k.args.join(' ') === '--user disable --now agentconnect.service')).toBe(true)
  })

  it('status reports the journalctl command, not a log file (logs go to the journal)', async () => {
    const { exec } = fakeExec()
    const c = new SystemdController({ root: root(), home: home(), uid: 1000, exec })
    const s = await c.status()
    expect(s.installed).toBe(false)
    expect(s.logPath).toBe('journalctl --user -u agentconnect.service')
    expect(s.logPath).not.toMatch(/daemon\.log/)
  })
})
