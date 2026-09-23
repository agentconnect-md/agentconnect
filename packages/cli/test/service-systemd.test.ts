import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
const sys = () => mkdtempSync(join(tmpdir(), 'ac-sys-'))
const polkit = () => mkdtempSync(join(tmpdir(), 'ac-polkit-'))
const sudoers = () => mkdtempSync(join(tmpdir(), 'ac-sudoers-'))

const ACCOUNT = { user: 'agent', uid: 1000, gid: 1000, home: '/home/agent' }

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
    const [h, sd, pd] = [home(), sys(), polkit()]
    const { exec } = fakeExec()
    const base = { home: h, uid: 1000, exec, systemUnitDir: sd, polkitDir: pd, sudoersDir: sudoers(), account: ACCOUNT }
    await new SystemdController({ ...base, root: '/srv/a' }).install({
      execPath: '/usr/bin/node',
      includeRootEnv: true
    })
    await new SystemdController({ ...base, root: '/srv/b', instance: 'b' }).install({
      execPath: '/usr/bin/node',
      includeRootEnv: true
    })
    writeFileSync(join(sd, 'unrelated.service'), '[Unit]\n')

    expect(scanSystemdUnits(h, sd)).toEqual([
      {
        label: 'agentconnect.service',
        root: '/srv/a',
        unitPath: expect.stringContaining('agentconnect.service'),
        scope: 'system',
        user: 'agent'
      },
      {
        instance: 'b',
        label: 'agentconnect@b.service',
        root: '/srv/b',
        unitPath: expect.stringContaining('agentconnect@b.service'),
        scope: 'system',
        user: 'agent'
      }
    ])
  })

  it('reports both scopes and sorts the system unit ahead of a same-named user one', async () => {
    const [h, sd, pd] = [home(), sys(), polkit()]
    const { exec } = fakeExec()
    await new SystemdController({
      root: '/srv/new',
      home: h,
      uid: 1000,
      exec,
      systemUnitDir: sd,
      polkitDir: pd,
      sudoersDir: sudoers(),
      account: ACCOUNT
    }).install({ execPath: '/usr/bin/node', includeRootEnv: true })
    await new SystemdController({ root: '/srv/old', home: h, uid: 1000, exec, scope: 'user' }).install({
      execPath: '/usr/bin/node',
      includeRootEnv: true
    })
    // A half-migrated host carries both; resolution must land on the system unit.
    expect(scanSystemdUnits(h, sd).map((u) => [u.scope, u.root])).toEqual([
      ['system', '/srv/new'],
      ['user', '/srv/old']
    ])
  })

  it('returns nothing when neither unit directory exists', () => {
    expect(scanSystemdUnits(join(home(), 'nope'), join(sys(), 'nope'))).toEqual([])
  })
})

describe('SystemdController (system scope)', () => {
  const build = (over: Record<string, unknown> = {}) => {
    const { exec, calls } = fakeExec()
    const [h, sd, pd, sud] = [home(), sys(), polkit(), sudoers()]
    const c = new SystemdController({
      root: root(),
      home: h,
      uid: 1000,
      exec,
      systemUnitDir: sd,
      polkitDir: pd,
      sudoersDir: sud,
      account: ACCOUNT,
      ...over
    })
    return { c, calls, h, sd, pd, sud }
  }

  it('install writes /etc/systemd/system, enables for boot, and drops the polkit rule', async () => {
    const { c, calls, sd, pd } = build()
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: false })
    const unit = readFileSync(join(sd, 'agentconnect.service'), 'utf8')
    // User= is what keeps agent execution on the ordinary account.
    expect(unit).toContain(`User=${ACCOUNT.user}`)
    expect(unit).toContain(`WorkingDirectory=${ACCOUNT.home}`)
    expect(unit).toContain(`Environment="HOME=${ACCOUNT.home}"`)
    expect(unit).toContain('WantedBy=multi-user.target')
    expect(unit).not.toContain('Group=') // systemd uses the account's primary group
    expect(calls.map((k) => k.args.join(' '))).toEqual(['daemon-reload', 'enable agentconnect.service'])
    const rule = readFileSync(join(pd, '49-agentconnect.rules'), 'utf8')
    expect(rule).toContain("action.lookup('unit') === 'agentconnect.service'")
    expect(rule).toContain("subject.user === 'agent'")
    // enable/disable stay root-only; the rule grants lifecycle verbs alone.
    expect(rule).not.toContain("'enable'")
  })

  it('writes the unit world-readable even under a restrictive umask', async () => {
    // A 0600 unit is unreadable by the daemon account, which also makes the
    // instance lister skip it and report the service as not installed.
    const { c, sd } = build()
    const previous = process.umask(0o077)
    try {
      await c.install({ execPath: '/usr/bin/node', includeRootEnv: false })
    } finally {
      process.umask(previous)
    }
    expect((statSync(join(sd, 'agentconnect.service')).mode & 0o777).toString(8)).toBe('644')
  })

  it('refuses to write a system unit with no resolved account', async () => {
    const { exec } = fakeExec()
    const c = new SystemdController({
      root: root(),
      home: home(),
      uid: 1000,
      exec,
      systemUnitDir: sys(),
      sudoersDir: sudoers()
    })
    await expect(c.install({ execPath: '/usr/bin/node', includeRootEnv: false })).rejects.toThrow(/service account/)
  })

  it('up starts and down stops — the verbs the polkit rule grants, never enable/disable', async () => {
    const { c, calls } = build()
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: false })
    calls.length = 0
    await c.up()
    await c.down()
    expect(calls.map((k) => k.args.join(' '))).toEqual(['start agentconnect.service', 'stop agentconnect.service'])
  })

  it('explains a polkit denial instead of surfacing a bare authentication error', async () => {
    const [sd, pd] = [sys(), polkit()]
    const exec: Exec = async () => ({ code: 1, stdout: '', stderr: 'Failed to start: Access denied' })
    const c = new SystemdController({
      root: root(),
      home: home(),
      uid: 1000,
      exec,
      systemUnitDir: sd,
      polkitDir: pd,
      sudoersDir: sudoers(),
      account: ACCOUNT
    })
    await expect(c.up()).rejects.toThrow(/refresh the polkit rule|sudo systemctl start/)
  })

  it('never falls back to sudo on a polkit host, and drops a grant left from before polkit', async () => {
    const [sd, pd, sud] = [sys(), polkit(), sudoers()]
    writeFileSync(join(sud, 'agentconnect'), 'stale\n')
    const calls: string[] = []
    const exec: Exec = async (cmd, args) => {
      calls.push(cmd)
      return args[0] === 'start'
        ? { code: 1, stdout: '', stderr: 'Access denied' }
        : { code: 0, stdout: '', stderr: '' }
    }
    const c = new SystemdController({
      root: root(),
      home: home(),
      uid: 1000,
      exec,
      systemUnitDir: sd,
      polkitDir: pd,
      sudoersDir: sud,
      account: ACCOUNT
    })
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: false })
    expect(existsSync(join(sud, 'agentconnect'))).toBe(false)
    await expect(c.up()).rejects.toThrow(/refresh the polkit rule/)
    expect(calls).not.toContain('sudo')
  })

  it('uninstall disables the unit and removes its polkit rule', async () => {
    const { c, calls, sd, pd } = build()
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: false })
    calls.length = 0
    await c.uninstall()
    expect(calls.map((k) => k.args.join(' '))).toEqual([
      'stop agentconnect.service',
      'disable agentconnect.service',
      'daemon-reload'
    ])
    expect(existsSync(join(sd, 'agentconnect.service'))).toBe(false)
    expect(existsSync(join(pd, '49-agentconnect.rules'))).toBe(false)
  })

  it('a named instance owns its own unit file, polkit rule and systemctl target', async () => {
    const { c, sd, pd } = build({ root: '/srv/b', instance: 'b' })
    expect(c.label).toBe('agentconnect@b.service')
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: true })
    expect(existsSync(join(sd, 'agentconnect@b.service'))).toBe(true)
    expect(existsSync(join(sd, 'agentconnect.service'))).toBe(false)
    expect(existsSync(join(pd, '49-agentconnect@b.rules'))).toBe(true)
    expect((await c.status()).logPath).toBe('journalctl -u agentconnect@b.service')
  })

  it('reports that unprivileged control is unavailable without a polkit rules.d backend', () => {
    const { exec } = fakeExec()
    const c = new SystemdController({
      root: root(),
      home: home(),
      uid: 1000,
      exec,
      systemUnitDir: sys(),
      polkitDir: join(sys(), 'absent'),
      sudoersDir: join(sys(), 'absent'),
      account: ACCOUNT
    })
    expect(c.hasUnprivilegedControl()).toBe(false)
  })
})

describe('SystemdController (no polkit rules.d backend)', () => {
  // `denied` makes a bare systemctl fail the way polkit < 0.106 over SSH does.
  const build = (opts: { denied?: boolean; visudo?: number; sudo?: number } = {}) => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const exec: Exec = async (cmd, args) => {
      calls.push({ cmd, args })
      if (cmd === 'visudo') return { code: opts.visudo ?? 0, stdout: '', stderr: '' }
      if (cmd === 'sudo')
        return { code: opts.sudo ?? 0, stdout: '', stderr: opts.sudo ? 'sudo: a password is required' : '' }
      const verb = args.find((a) => a === 'start' || a === 'stop')
      return opts.denied && verb
        ? { code: 1, stdout: '', stderr: `Failed to ${verb} ${args.at(-1)}: Access denied` }
        : { code: 0, stdout: '', stderr: '' }
    }
    const sud = sudoers()
    const c = new SystemdController({
      root: root(),
      home: home(),
      uid: 1000,
      exec,
      systemUnitDir: sys(),
      polkitDir: join(sys(), 'absent'),
      sudoersDir: sud,
      account: ACCOUNT
    })
    return { c, calls, sud }
  }
  const asRoot = typeof process.geteuid === 'function' && process.geteuid() === 0

  it('install writes a visudo-checked sudoers grant for this unit and account only', async () => {
    const { c, calls, sud } = build()
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: false })
    const path = join(sud, 'agentconnect')
    const rule = readFileSync(path, 'utf8')
    expect(rule).toMatch(
      /^agent ALL=\(root\) NOPASSWD: \S+systemctl start agentconnect\.service, \S+systemctl stop agentconnect\.service, \S+systemctl restart agentconnect\.service$/m
    )
    expect(rule).not.toMatch(/enable|disable/)
    expect((statSync(path).mode & 0o777).toString(8)).toBe('440')
    expect(calls.find((k) => k.cmd === 'visudo')?.args).toEqual(['-c', '-q', '-f', `${path}.tmp`])
    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(c.hasUnprivilegedControl()).toBe(true)
  })

  it('names a named instance drop-in without the dot sudo would skip it for', async () => {
    const { exec } = fakeExec()
    const sud = sudoers()
    const c = new SystemdController({
      root: '/srv/b',
      instance: 'b',
      home: home(),
      uid: 1000,
      exec,
      systemUnitDir: sys(),
      polkitDir: join(sys(), 'absent'),
      sudoersDir: sud,
      account: ACCOUNT
    })
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: true })
    expect(readFileSync(join(sud, 'agentconnect-b'), 'utf8')).toContain('start agentconnect@b.service')
  })

  it('discards a grant visudo rejects, leaving sudo untouched', async () => {
    const { c, sud } = build({ visudo: 1 })
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: false })
    expect(existsSync(join(sud, 'agentconnect'))).toBe(false)
    expect(existsSync(join(sud, 'agentconnect.tmp'))).toBe(false)
    expect(c.hasUnprivilegedControl()).toBe(false)
  })

  it.skipIf(asRoot)('up and down fall back to sudo -n when systemctl is denied', async () => {
    const { c, calls } = build({ denied: true })
    await c.up()
    await c.down()
    expect(calls.map((k) => [k.cmd, ...k.args.map((a) => a.replace(/^\/(usr\/)?bin\//, ''))].join(' '))).toEqual([
      'systemctl --no-ask-password start agentconnect.service',
      'sudo -n systemctl start agentconnect.service',
      'systemctl --no-ask-password stop agentconnect.service',
      'sudo -n systemctl stop agentconnect.service'
    ])
  })

  it.skipIf(asRoot)('explains a missing grant when the sudo fallback needs a password too', async () => {
    const { c } = build({ denied: true, sudo: 1 })
    await expect(c.up()).rejects.toThrow(/no sudoers grant for agentconnect\.service.*install-service/)
  })

  it('uninstall removes the sudoers grant', async () => {
    const { c, sud } = build()
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: false })
    await c.uninstall()
    expect(existsSync(join(sud, 'agentconnect'))).toBe(false)
  })
})

describe('SystemdController (legacy user scope)', () => {
  const build = () => {
    const { exec, calls } = fakeExec()
    const h = home()
    return { c: new SystemdController({ root: root(), home: h, uid: 1000, exec, scope: 'user' }), calls, h }
  }

  it('install writes the unit and daemon-reloads, with no enable and no polkit rule', async () => {
    const { c, calls, h } = build()
    await c.install({ execPath: '/usr/bin/node', includeRootEnv: false })
    const unitPath = join(h, '.config', 'systemd', 'user', 'agentconnect.service')
    expect(existsSync(unitPath)).toBe(true)
    const unit = readFileSync(unitPath, 'utf8')
    expect(unit).toContain('ExecStart=')
    // Byte-for-byte the historical form, so an existing install is never orphaned.
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).not.toContain('User=')
    expect(calls.map((k) => k.args.join(' '))).toEqual(['--user daemon-reload'])
  })

  it('keeps enable/disable --now, the only lifecycle those units ever had', async () => {
    const { c, calls } = build()
    await c.up()
    await c.down()
    expect(calls.some((k) => k.args.join(' ') === '--user enable --now agentconnect.service')).toBe(true)
    expect(calls.some((k) => k.args.join(' ') === '--user disable --now agentconnect.service')).toBe(true)
  })

  it('status reports the journalctl command, not a log file (logs go to the journal)', async () => {
    const { c } = build()
    const s = await c.status()
    expect(s.installed).toBe(false)
    expect(s.logPath).toBe('journalctl --user -u agentconnect.service')
    expect(s.logPath).not.toMatch(/daemon\.log/)
  })
})
