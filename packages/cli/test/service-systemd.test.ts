import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSystemdUnit,
  parseUnitRoot,
  scanSystemdUnits,
  systemdUnitName,
  SystemdController
} from '../src/service/systemd.js'
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
    // `--root` is explicit so a login-shell profile exporting AGENTCONNECT_ROOT
    // cannot drag this unit onto another instance's root.
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /home/u/.agentconnect/current/dist/index.js run --root /home/u/.agentconnect'
    )
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
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /nvm/lib/node_modules/agentconnect/dist/index.js run --root /home/u/.agentconnect'
    )
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
    expect(unit).toContain('Environment="AGENTCONNECT_ROOT=/custom"')
    expect(unit).toContain('ExecStart=/usr/bin/node /custom/current/dist/index.js run --root /custom')
  })

  it('names the instance in Description and quotes ExecStart tokens that need it', () => {
    const unit = buildSystemdUnit({
      execPath: '/usr/bin/node',
      root: '/home/u/my roots/.agentconnect-dev',
      includeRootEnv: true,
      instance: 'dev'
    })
    expect(unit).toContain('Description=AgentConnect daemon (dev)')
    expect(unit).toContain('run --root "/home/u/my roots/.agentconnect-dev"')
    expect(unit).toContain('Environment="AGENTCONNECT_ROOT=/home/u/my roots/.agentconnect-dev"')
  })
})

describe('systemdUnitName', () => {
  it('keeps the historical name for the default instance', () => {
    expect(systemdUnitName()).toBe('agentconnect.service')
  })
  it('gives a named instance its own unit', () => {
    expect(systemdUnitName('dev')).toBe('agentconnect@dev.service')
  })
})

describe('parseUnitRoot', () => {
  it('reads the baked --root, quoted or bare', () => {
    expect(parseUnitRoot('ExecStart=/usr/bin/node /x/current/dist/index.js run --root /srv/ac-b\n')).toBe('/srv/ac-b')
    expect(parseUnitRoot('ExecStart=/n /e run --root "/srv/ac b"\n')).toBe('/srv/ac b')
  })
  it('falls back to AGENTCONNECT_ROOT, then to the default root (legacy units)', () => {
    expect(parseUnitRoot('ExecStart=/n /e run\nEnvironment="AGENTCONNECT_ROOT=/srv/legacy"\n')).toBe('/srv/legacy')
    expect(parseUnitRoot('ExecStart=/n /e run\nEnvironment=AGENTCONNECT_ROOT=/srv/older\n')).toBe('/srv/older')
    expect(parseUnitRoot('ExecStart=/n /e run\n')).toBe(join(homedir(), '.agentconnect'))
  })
})

describe('scanSystemdUnits', () => {
  it('finds the default and every named instance with its root, ignoring other units', async () => {
    const h = home()
    const { exec } = fakeExec()
    await new SystemdController({ root: '/srv/a', home: h, uid: 1000, exec }).install({
      execPath: '/usr/bin/node',
      includeRootEnv: true
    })
    await new SystemdController({ root: '/srv/b', home: h, uid: 1000, exec, instance: 'b' }).install({
      execPath: '/usr/bin/node',
      includeRootEnv: true
    })
    writeFileSync(join(h, '.config', 'systemd', 'user', 'unrelated.service'), '[Unit]\n')

    expect(scanSystemdUnits(h)).toEqual([
      { label: 'agentconnect.service', root: '/srv/a', unitPath: expect.stringContaining('agentconnect.service') },
      {
        instance: 'b',
        label: 'agentconnect@b.service',
        root: '/srv/b',
        unitPath: expect.stringContaining('agentconnect@b.service')
      }
    ])
  })

  it('returns nothing when the unit directory does not exist', () => {
    expect(scanSystemdUnits(join(home(), 'nope'))).toEqual([])
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

  it('a named instance owns its own unit file and systemctl target', async () => {
    const h = home()
    const { exec, calls } = fakeExec()
    const c = new SystemdController({ root: '/srv/b', home: h, uid: 1000, exec, instance: 'b' })
    expect(c.label).toBe('agentconnect@b.service')
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: true })
    expect(existsSync(join(h, '.config', 'systemd', 'user', 'agentconnect@b.service'))).toBe(true)
    expect(existsSync(join(h, '.config', 'systemd', 'user', 'agentconnect.service'))).toBe(false)
    await c.up()
    await c.down()
    expect(calls.some((k) => k.args.join(' ') === '--user enable --now agentconnect@b.service')).toBe(true)
    expect(calls.some((k) => k.args.join(' ') === '--user disable --now agentconnect@b.service')).toBe(true)
    expect((await c.status()).logPath).toBe('journalctl --user -u agentconnect@b.service')
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
