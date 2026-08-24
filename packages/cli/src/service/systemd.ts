/** Linux systemd `--user` controller. Writes a unit running
 *  `<node> <cli-entry> run --root <root>` (the CLI run shell; legacy fallback is
 *  the daemon's `<root>/current/dist/index.js`) and drives it with
 *  `systemctl --user enable/disable --now`. */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { currentDistEntry, defaultRoot } from '../paths.js'
import type { ControllerDeps, InstalledUnit, InstallOpts, ServiceController, ServiceStatus } from './types.js'

const DEFAULT_UNIT = 'agentconnect.service'

/** `agentconnect.service` for the default instance, `agentconnect@<name>.service`
 *  for a named one — a concrete unit file, not a template instantiation. */
export function systemdUnitName(instance?: string): string {
  return instance ? `agentconnect@${instance}.service` : DEFAULT_UNIT
}

/** The user-unit directory, and the file name pattern the instance lister scans. */
export function systemdUnitDir(home: string): string {
  return join(home, '.config', 'systemd', 'user')
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

function unquote(value: string): string {
  const inner = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  return inner.replace(/\\(.)/g, '$1').replace(/%%/g, '%')
}

/** Every AgentConnect user unit on this host, default instance included. */
export function scanSystemdUnits(home: string): InstalledUnit[] {
  const dir = systemdUnitDir(home)
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
    found.push({ ...(match[1] ? { instance: match[1] } : {}), label: name, unitPath, root: parseUnitRoot(text) })
  }
  // Default instance first, then named ones alphabetically — the order the
  // `instances` listing reads best in.
  return found.sort((a, b) => (a.instance ?? '').localeCompare(b.instance ?? ''))
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
}): string {
  // AGENTCONNECT_SUPERVISOR=service is always set so the daemon accepts
  // CP-commanded restart/upgrade (§7.1). Restart=always relaunches on the
  // daemon's reserved planned-exit code (and any crash).
  const rootEnv = a.includeRootEnv ? `${systemdEnvAssignment('AGENTCONNECT_ROOT', a.root)}\n` : ''
  // systemd --user units get a minimal PATH and never source shell profiles, so
  // carry the installing shell's PATH (InstallOpts.envPath) into the service.
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
  return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execArg(a.execPath)} ${execArg(entry)} run --root ${execArg(a.root)}
Restart=always
RestartSec=3
KillMode=mixed
Environment=AGENTCONNECT_SUPERVISOR=service
${pathEnv}${rootEnv}
[Install]
WantedBy=default.target
`
}

export class SystemdController implements ServiceController {
  readonly label: string
  private readonly unitPath: string

  constructor(private readonly deps: ControllerDeps) {
    this.label = systemdUnitName(deps.instance)
    this.unitPath = join(systemdUnitDir(deps.home), this.label)
  }

  isInstalled(): boolean {
    return existsSync(this.unitPath)
  }

  async install(opts: InstallOpts): Promise<void> {
    mkdirSync(dirname(this.unitPath), { recursive: true })
    // Unconditional overwrite migrates a legacy unit (old ExecStart, no
    // supervisor marker) to the current-symlink form on re-install (§6).
    writeFileSync(
      this.unitPath,
      buildSystemdUnit({
        execPath: opts.execPath,
        root: this.deps.root,
        includeRootEnv: opts.includeRootEnv,
        ...(this.deps.instance ? { instance: this.deps.instance } : {}),
        ...(opts.cliEntry ? { cliEntry: opts.cliEntry } : {}),
        ...(opts.envPath ? { envPath: opts.envPath } : {})
      })
    )
    await this.deps.exec('systemctl', ['--user', 'daemon-reload'])
  }

  async uninstall(): Promise<void> {
    try {
      await this.down()
    } catch {
      // not running — fine
    }
    if (this.isInstalled()) rmSync(this.unitPath)
    await this.deps.exec('systemctl', ['--user', 'daemon-reload'])
  }

  async up(): Promise<void> {
    const r = await this.deps.exec('systemctl', ['--user', 'enable', '--now', this.label])
    if (r.code !== 0) throw new Error(`systemctl could not start the service: ${r.stderr}`)
  }

  async down(): Promise<void> {
    await this.deps.exec('systemctl', ['--user', 'disable', '--now', this.label])
  }

  async status(): Promise<ServiceStatus> {
    // systemd captures the daemon's stdout/stderr into the journal (the unit
    // writes no log file), so the "log path" is the journalctl command to read it.
    const logPath = `journalctl --user -u ${this.label}`
    if (!this.isInstalled()) return { installed: false, running: false, label: this.label, logPath }
    const active = await this.deps.exec('systemctl', ['--user', 'is-active', this.label])
    const running = active.stdout.trim() === 'active'
    const main = await this.deps.exec('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', this.label])
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
