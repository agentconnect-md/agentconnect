/** Linux systemd `--user` controller. Writes a unit running
 *  `<node> <root>/current/dist/index.js run` and drives it with
 *  `systemctl --user enable/disable --now`. */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { currentDistEntry } from '../paths.js'
import type { ControllerDeps, InstallOpts, ServiceController, ServiceStatus } from './types.js'

const UNIT = 'agentconnect.service'

export function buildSystemdUnit(a: { execPath: string; root: string; includeRootEnv: boolean }): string {
  // AGENTCONNECT_SUPERVISOR=service is always set so the daemon accepts
  // CP-commanded restart/upgrade (§7.1). Restart=always relaunches on the
  // daemon's reserved planned-exit code (and any crash).
  const rootEnv = a.includeRootEnv ? `Environment=AGENTCONNECT_ROOT=${a.root}\n` : ''
  // ExecStart runs the daemon through the `current` symlink so upgrades take
  // effect on next restart without reinstalling the unit.
  return `[Unit]
Description=AgentConnect daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${a.execPath} ${currentDistEntry(a.root)} run
Restart=always
RestartSec=3
Environment=AGENTCONNECT_SUPERVISOR=service
${rootEnv}
[Install]
WantedBy=default.target
`
}

export class SystemdController implements ServiceController {
  readonly label = UNIT
  private readonly unitPath: string

  constructor(private readonly deps: ControllerDeps) {
    this.unitPath = join(deps.home, '.config', 'systemd', 'user', UNIT)
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
        includeRootEnv: opts.includeRootEnv
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
    const r = await this.deps.exec('systemctl', ['--user', 'enable', '--now', UNIT])
    if (r.code !== 0) throw new Error(`systemctl could not start the service: ${r.stderr}`)
  }

  async down(): Promise<void> {
    await this.deps.exec('systemctl', ['--user', 'disable', '--now', UNIT])
  }

  async status(): Promise<ServiceStatus> {
    // systemd captures the daemon's stdout/stderr into the journal (the unit
    // writes no log file), so the "log path" is the journalctl command to read it.
    const logPath = `journalctl --user -u ${UNIT}`
    if (!this.isInstalled()) return { installed: false, running: false, label: UNIT, logPath }
    const active = await this.deps.exec('systemctl', ['--user', 'is-active', UNIT])
    const running = active.stdout.trim() === 'active'
    const main = await this.deps.exec('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', UNIT])
    const pid = Number(main.stdout.trim())
    return {
      installed: true,
      running,
      ...(Number.isFinite(pid) && pid > 0 ? { pid } : {}),
      label: UNIT,
      logPath
    }
  }
}
