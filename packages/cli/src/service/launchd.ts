/** macOS launchd controller. Writes a LaunchAgent plist that runs
 *  `<node> <root>/current/dist/index.js run`, and drives it with `launchctl
 *  bootstrap/bootout` (falling back to legacy `load/unload` on older macOS). */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { currentDistEntry, daemonLogPath, logsDir } from '../paths.js'
import type { ControllerDeps, InstallOpts, ServiceController, ServiceStatus } from './types.js'

const LABEL = 'md.agentconnect.daemon'

export function buildPlist(a: {
  label: string
  execPath: string
  logPath: string
  root: string
  includeRootEnv: boolean
}): string {
  // Always mark the child as service-supervised so the daemon accepts
  // CP-commanded restart/upgrade (cli-daemon-split.md §7.1); the daemon can no
  // longer self-detect service parentage now that the controller lives in the CLI.
  const envEntries: Array<[string, string]> = [['AGENTCONNECT_SUPERVISOR', 'service']]
  if (a.includeRootEnv) envEntries.push(['AGENTCONNECT_ROOT', a.root])
  const env =
    '  <key>EnvironmentVariables</key>\n  <dict>\n' +
    envEntries.map(([k, v]) => `    <key>${k}</key>\n    <string>${v}</string>\n`).join('') +
    '  </dict>\n'
  // ProgramArguments runs the daemon through the `current` symlink so upgrades
  // (flip `current`) take effect on next relaunch without reinstalling the unit.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${a.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${a.execPath}</string>
    <string>${currentDistEntry(a.root)}</string>
    <string>run</string>
  </array>
${env}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${a.logPath}</string>
  <key>StandardErrorPath</key>
  <string>${a.logPath}</string>
</dict>
</plist>
`
}

export class LaunchdController implements ServiceController {
  readonly label = LABEL
  private readonly plistPath: string

  constructor(private readonly deps: ControllerDeps) {
    this.plistPath = join(deps.home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
  }

  isInstalled(): boolean {
    return existsSync(this.plistPath)
  }

  async install(opts: InstallOpts): Promise<void> {
    mkdirSync(logsDir(this.deps.root), { recursive: true })
    mkdirSync(dirname(this.plistPath), { recursive: true })
    // Unconditional overwrite: re-running install-service rewrites a legacy unit
    // (old ExecStart pointing at a versioned dist, no supervisor marker) into the
    // current-symlink form — the one-shot migration path (§6).
    const plist = buildPlist({
      label: LABEL,
      execPath: opts.execPath,
      logPath: daemonLogPath(this.deps.root),
      root: this.deps.root,
      includeRootEnv: opts.includeRootEnv
    })
    writeFileSync(this.plistPath, plist)
  }

  async uninstall(): Promise<void> {
    try {
      await this.down()
    } catch {
      // not loaded — fine
    }
    if (this.isInstalled()) rmSync(this.plistPath)
  }

  async up(): Promise<void> {
    const domain = `gui/${this.deps.uid}`
    const r = await this.deps.exec('launchctl', ['bootstrap', domain, this.plistPath])
    if (r.code !== 0) {
      const legacy = await this.deps.exec('launchctl', ['load', '-w', this.plistPath])
      if (legacy.code !== 0) throw new Error(`launchctl could not start the service: ${r.stderr || legacy.stderr}`)
    }
  }

  async down(): Promise<void> {
    const r = await this.deps.exec('launchctl', ['bootout', `gui/${this.deps.uid}/${LABEL}`])
    if (r.code !== 0) {
      await this.deps.exec('launchctl', ['unload', '-w', this.plistPath])
    }
  }

  async status(): Promise<ServiceStatus> {
    const logPath = daemonLogPath(this.deps.root)
    if (!this.isInstalled()) return { installed: false, running: false, label: LABEL, logPath }
    const r = await this.deps.exec('launchctl', ['print', `gui/${this.deps.uid}/${LABEL}`])
    const running = r.code === 0
    const pidMatch = /\bpid = (\d+)/.exec(r.stdout)
    return {
      installed: true,
      running,
      ...(pidMatch ? { pid: Number(pidMatch[1]) } : {}),
      label: LABEL,
      logPath
    }
  }
}
