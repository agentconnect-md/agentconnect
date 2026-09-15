/** Linux systemd controller, in two scopes. `system` (the default) writes
 *  `/etc/systemd/system/<unit>` with `User=` so the unit outlives every login
 *  session; `user` drives the legacy `~/.config/systemd/user` units still installed
 *  on existing hosts, unchanged, so they stay stoppable and removable. */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { currentDistEntry, defaultRoot } from '../paths.js'
import type { ServiceAccount } from './account.js'
import { POLKIT_RULES_DIR, polkitRulesSupported, removePolkitRule, writePolkitRule } from './polkit.js'
import type { ControllerDeps, InstalledUnit, InstallOpts, ServiceController, ServiceStatus } from './types.js'

const DEFAULT_UNIT = 'agentconnect.service'

export type SystemdScope = 'system' | 'user'

/** Where a system unit lives. A constant, but injectable so tests never touch /etc. */
export const SYSTEM_UNIT_DIR = '/etc/systemd/system'

/** `agentconnect.service` for the default instance, `agentconnect@<name>.service`
 *  for a named one — a concrete unit file, not a template instantiation. */
export function systemdUnitName(instance?: string): string {
  return instance ? `agentconnect@${instance}.service` : DEFAULT_UNIT
}

/** The unit directory for a scope, and the directory the instance lister scans. */
export function systemdUnitDir(scope: SystemdScope, home: string, systemUnitDir: string = SYSTEM_UNIT_DIR): string {
  return scope === 'system' ? systemUnitDir : join(home, '.config', 'systemd', 'user')
}

/** `systemctl` prefix for a scope. System scope needs no flag: reads work for anyone,
 *  writes are either root (install/uninstall) or polkit-authorized (start/stop). */
export function systemctlArgs(scope: SystemdScope): string[] {
  return scope === 'system' ? [] : ['--user']
}

const SYSTEMD_UNIT_PATTERN = /^agentconnect(?:@([a-z0-9][a-z0-9_-]*))?\.service$/

/** The root a written unit runs against: the `--root` we bake into ExecStart,
 *  else `AGENTCONNECT_ROOT`, else the default (a legacy unit predating both). */
export function parseUnitRoot(text: string): string {
  const arg = /^ExecStart=.*?\s--root\s+("(?:[^"\\]|\\.)*"|\S+)/m.exec(text)?.[1]
  if (arg) return unquote(arg)
  const env = /^Environment=(?:"?)AGENTCONNECT_ROOT=("(?:[^"\\]|\\.)*"|[^"\n]*)"?$/m.exec(text)?.[1]
  return env ? unquote(env) : defaultRoot()
}

/** The account a system unit runs the daemon as, read back off `User=`. */
export function parseUnitUser(text: string): string | undefined {
  return /^User=(\S+)$/m.exec(text)?.[1]
}

function unquote(value: string): string {
  const inner = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  return inner.replace(/\\(.)/g, '$1').replace(/%%/g, '%')
}

function scanDir(dir: string, scope: SystemdScope): InstalledUnit[] {
  if (!existsSync(dir)) return []
  const found: InstalledUnit[] = []
  for (const name of readdirSync(dir).sort()) {
    const match = SYSTEMD_UNIT_PATTERN.exec(name)
    if (!match) continue
    const unitPath = join(dir, name)
    let text = ''
    try {
      text = readFileSync(unitPath, 'utf8')
    } catch {
      continue // unreadable unit — nothing useful to report about it
    }
    const user = parseUnitUser(text)
    found.push({
      ...(match[1] ? { instance: match[1] } : {}),
      label: name,
      unitPath,
      root: parseUnitRoot(text),
      scope,
      ...(user ? { user } : {})
    })
  }
  return found
}

/** Every AgentConnect unit on this host, both scopes, default instance included.
 *  System units sort ahead of a same-named user unit so resolution prefers the
 *  current form while a half-migrated host still carries both. */
export function scanSystemdUnits(home: string, systemUnitDir: string = SYSTEM_UNIT_DIR): InstalledUnit[] {
  const found = [...scanDir(systemUnitDir, 'system'), ...scanDir(systemdUnitDir('user', home), 'user')]
  const scopeRank = (u: InstalledUnit): number => (u.scope === 'system' ? 0 : 1)
  return found.sort((a, b) => (a.instance ?? '').localeCompare(b.instance ?? '') || scopeRank(a) - scopeRank(b))
}

/** Quote a value for a systemd `Environment=` assignment: `%` is a specifier
 *  prefix (`%%` escapes it); backslash and double-quote need backslash escapes
 *  inside the quoted form. */
function systemdEnvAssignment(name: string, value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  return `Environment="${name}=${escaped}"`
}

/** A single ExecStart token. systemd splits the command line on whitespace and
 *  reads `%` as a specifier prefix, so escape `%` and quote only when the token
 *  needs it — space-free paths stay byte-identical to the historical form. */
function execArg(value: string): string {
  const escaped = value.replace(/%/g, '%%')
  return /[\s"'\\]/.test(escaped) ? `"${escaped.replace(/(["\\])/g, '\\$1')}"` : escaped
}

export function buildSystemdUnit(a: {
  execPath: string
  root: string
  includeRootEnv: boolean
  cliEntry?: string
  envPath?: string
  instance?: string
  scope?: SystemdScope
  account?: ServiceAccount
}): string {
  const scope = a.scope ?? 'user'
  // AGENTCONNECT_SUPERVISOR=service is always set so the daemon accepts
  // CP-commanded restart/upgrade (§7.1). Restart=always relaunches on the
  // daemon's reserved planned-exit code (and any crash).
  const rootEnv = a.includeRootEnv ? `${systemdEnvAssignment('AGENTCONNECT_ROOT', a.root)}\n` : ''
  // systemd units get a minimal PATH and never source shell profiles, so carry
  // the installing shell's PATH (InstallOpts.envPath) into the service.
  const pathEnv = a.envPath ? `${systemdEnvAssignment('PATH', a.envPath)}\n` : ''
  // With a cliEntry the unit runs the CLI run shell, which launches the daemon
  // through the user's login shell (fresh terminal-equivalent env) and handles
  // the reserved restart code itself; the daemon entry is still resolved via
  // <root>/current at every (re)spawn, so upgrades keep working unit-untouched.
  // KillMode=mixed: stop delivers SIGTERM to the main process ONLY (the run
  // shell forwards exactly one TERM to the daemon — control-group would TERM
  // both and the daemon's second-signal handler force-exits mid-drain), while
  // the final KILL escalation still sweeps the whole cgroup.
  const entry = a.cliEntry ?? currentDistEntry(a.root)
  // `--root` is explicit in ExecStart, not left to inherited env: the run shell
  // launches the daemon through the user's interactive login shell, so a profile
  // exporting AGENTCONNECT_ROOT would otherwise drag this instance onto another
  // instance's root (and its lock, sqlite, socket). The flag beats env.
  const description = a.instance ? `AgentConnect daemon (${a.instance})` : 'AgentConnect daemon'
  // A system unit runs as the operator's own account, never root: `Group=` is
  // omitted so systemd uses that account's primary group. HOME is baked because
  // every daemon path below `<root>` and the login-shell launch depend on it.
  const identity =
    scope === 'system' && a.account
      ? `User=${a.account.user}\nWorkingDirectory=${a.account.home}\n${systemdEnvAssignment('HOME', a.account.home)}\n`
      : ''
  // multi-user.target is what makes the unit start at boot with nobody logged in;
  // default.target is the user manager's equivalent and only runs while it does.
  const wantedBy = scope === 'system' ? 'multi-user.target' : 'default.target'
  return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${identity}ExecStart=${execArg(a.execPath)} ${execArg(entry)} run --root ${execArg(a.root)}
Restart=always
RestartSec=3
KillMode=mixed
Environment=AGENTCONNECT_SUPERVISOR=service
${pathEnv}${rootEnv}
[Install]
WantedBy=${wantedBy}
`
}

export class SystemdController implements ServiceController {
  readonly label: string
  readonly scope: SystemdScope
  private readonly unitPath: string
  private readonly polkitDir: string

  constructor(private readonly deps: ControllerDeps) {
    this.label = systemdUnitName(deps.instance)
    this.scope = deps.scope ?? 'system'
    this.unitPath = join(systemdUnitDir(this.scope, deps.home, deps.systemUnitDir), this.label)
    this.polkitDir = deps.polkitDir ?? POLKIT_RULES_DIR
  }

  private systemctl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.deps.exec('systemctl', [...systemctlArgs(this.scope), ...args])
  }

  isInstalled(): boolean {
    return existsSync(this.unitPath)
  }

  /** System scope also does the `enable` here, so `up` only needs `start` — the
   *  verb the polkit rule grants. Boot persistence is an install-time decision. */
  async install(opts: InstallOpts): Promise<void> {
    const account = this.scope === 'system' ? this.deps.account : undefined
    if (this.scope === 'system' && !account) throw new Error('internal: a system unit needs a resolved service account')
    mkdirSync(dirname(this.unitPath), { recursive: true })
    // Unconditional overwrite migrates a legacy unit (old ExecStart, no
    // supervisor marker) to the current-symlink form on re-install (§6).
    writeFileSync(
      this.unitPath,
      buildSystemdUnit({
        execPath: opts.execPath,
        root: this.deps.root,
        includeRootEnv: opts.includeRootEnv,
        scope: this.scope,
        ...(account ? { account } : {}),
        ...(this.deps.instance ? { instance: this.deps.instance } : {}),
        ...(opts.cliEntry ? { cliEntry: opts.cliEntry } : {}),
        ...(opts.envPath ? { envPath: opts.envPath } : {})
      })
    )
    // The umask masks `writeFileSync`'s mode, so under umask 077 the unit would
    // land 0600 and the daemon account could not read it — which also makes the
    // instance lister skip it and report the service as not installed.
    chmodSync(this.unitPath, 0o644)
    await this.systemctl(['daemon-reload'])
    if (this.scope !== 'system' || !account) return
    const enabled = await this.systemctl(['enable', this.label])
    if (enabled.code !== 0) throw new Error(`systemctl could not enable ${this.label}: ${enabled.stderr.trim()}`)
    if (polkitRulesSupported(this.polkitDir)) {
      writePolkitRule({ unitLabel: this.label, user: account.user, dir: this.polkitDir })
    }
  }

  /** Whether `up`/`down` will work for the daemon account without sudo. */
  hasUnprivilegedControl(): boolean {
    return this.scope === 'user' || polkitRulesSupported(this.polkitDir)
  }

  async uninstall(): Promise<void> {
    try {
      await this.down()
    } catch {
      // not running — fine
    }
    if (this.scope === 'system') {
      await this.systemctl(['disable', this.label])
      removePolkitRule(this.label, this.polkitDir)
    }
    if (this.isInstalled()) rmSync(this.unitPath)
    await this.systemctl(['daemon-reload'])
  }

  async up(): Promise<void> {
    // User scope keeps `enable --now`: those units have no install-time enable step.
    const args = this.scope === 'system' ? ['start', this.label] : ['enable', '--now', this.label]
    const r = await this.systemctl(args)
    if (r.code !== 0) throw new Error(`systemctl could not start the service: ${this.explain(r.stderr)}`)
  }

  async down(): Promise<void> {
    const args = this.scope === 'system' ? ['stop', this.label] : ['disable', '--now', this.label]
    const r = await this.systemctl(args)
    if (this.scope === 'system' && r.code !== 0) {
      throw new Error(`systemctl could not stop the service: ${this.explain(r.stderr)}`)
    }
  }

  /** A polkit denial reads as an authentication failure, which says nothing about
   *  what to do; name the missing grant and the command that works regardless. */
  private explain(stderr: string): string {
    const text = stderr.trim()
    if (!/authentic|polkit|denied|permission/i.test(text)) return text
    const why = polkitRulesSupported(this.polkitDir)
      ? `reinstall with \`sudo agentconnect install-service\` to refresh the polkit rule for ${this.label}`
      : 'this host has no polkit rules.d backend, so unit control needs root'
    return `${text} — ${why}, or run \`sudo systemctl ${this.scope === 'system' ? '' : '--user '}start ${this.label}\``
  }

  async status(): Promise<ServiceStatus> {
    // systemd captures the daemon's stdout/stderr into the journal (the unit
    // writes no log file), so the "log path" is the journalctl command to read it.
    const logPath = ['journalctl', ...systemctlArgs(this.scope), '-u', this.label].join(' ')
    if (!this.isInstalled()) return { installed: false, running: false, label: this.label, logPath }
    const active = await this.systemctl(['is-active', this.label])
    const running = active.stdout.trim() === 'active'
    const main = await this.systemctl(['show', '-p', 'MainPID', '--value', this.label])
    const pid = Number(main.stdout.trim())
    return {
      installed: true,
      running,
      ...(Number.isFinite(pid) && pid > 0 ? { pid } : {}),
      label: this.label,
      logPath
    }
  }
}
