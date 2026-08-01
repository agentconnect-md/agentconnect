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
    // TERM goes to the main process only (the run shell forwards exactly one
    // TERM to the daemon); KILL escalation still sweeps the cgroup.
    expect(unit).toContain('KillMode=mixed')
    expect(unit).toContain('Environment=AGENTCONNECT_SUPERVISOR=service')
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).not.toContain('AGENTCONNECT_ROOT')
  })

  it('runs the CLI run shell when a cliEntry is pinned', () => {
    const unit = buildSystemdUnit({
      execPath: '/usr/bin/node',
      root: '/home/u/.agentconnect',
      includeRootEnv: false,
      cliEntry: '/nvm/lib/node_modules/agentconnect/dist/index.js'
    })
    expect(unit).toContain('ExecStart=/usr/bin/node /nvm/lib/node_modules/agentconnect/dist/index.js run')
    expect(unit).not.toContain('current/dist/index.js')
  })

  it('bakes the installing shell PATH in as a quoted, %-escaped Environment line', () => {
    const unit = buildSystemdUnit({
      execPath: '/usr/bin/node',
      root: '/home/u/.agentconnect',
      includeRootEnv: false,
      envPath: '/home/u/.nvm/versions/node/v24.16.0/bin:/dir with space:/opt/100%/bin'
    })
    expect(unit).toContain('Environment="PATH=/home/u/.nvm/versions/node/v24.16.0/bin:/dir with space:/opt/100%%/bin"')
  })

  it('omits the PATH line when no envPath is supplied', () => {
    const unit = buildSystemdUnit({ execPath: '/usr/bin/node', root: '/home/u/.agentconnect', includeRootEnv: false })
    expect(unit).not.toContain('Environment="PATH=')
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
