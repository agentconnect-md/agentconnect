/** macOS launchd controller. Writes a LaunchAgent plist that runs
 *  `<node> <cli-entry> run` (the CLI run shell; legacy fallback is the daemon's
 *  `<root>/current/dist/index.js`), and drives it with `launchctl
 *  bootstrap/bootout` (falling back to legacy `load/unload` on older macOS). */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { currentDistEntry, daemonLogPath, logsDir } from '../paths.js'
import type { ControllerDeps, InstallOpts, ServiceController, ServiceStatus } from './types.js'

const LABEL = 'md.agentconnect.daemon'

/** Minimal XML text escaping for plist string values. */
function xml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function buildPlist(a: {
  label: string
  execPath: string
  logPath: string
  root: string
  includeRootEnv: boolean
  cliEntry?: string
  envPath?: string
}): string {
  // Always mark the child as service-supervised so the daemon accepts
  // CP-commanded restart/upgrade (cli-daemon-split.md §7.1); the daemon can no
  // longer self-detect service parentage now that the controller lives in the CLI.
  const envEntries: Array<[string, string]> = [['AGENTCONNECT_SUPERVISOR', 'service']]
  if (a.includeRootEnv) envEntries.push(['AGENTCONNECT_ROOT', a.root])
  // launchd agents get a minimal PATH and never source shell profiles, so carry
  // the installing shell's PATH (InstallOpts.envPath) into the service.
  if (a.envPath) envEntries.push(['PATH', a.envPath])
  const env =
    '  <key>EnvironmentVariables</key>\n  <dict>\n' +
    envEntries.map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>\n`).join('') +
    '  </dict>\n'
  // With a cliEntry the agent runs the CLI run shell, which launches the daemon
  // through the user's login shell (fresh terminal-equivalent env) and resolves
  // the daemon entry via <root>/current at every (re)spawn — upgrades keep
  // working without reinstalling the agent. Legacy form runs the daemon direct.
  const entry = a.cliEntry ?? currentDistEntry(a.root)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${a.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(a.execPath)}</string>
    <string>${xml(entry)}</string>
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
      includeRootEnv: opts.includeRootEnv,
      ...(opts.cliEntry ? { cliEntry: opts.cliEntry } : {}),
      ...(opts.envPath ? { envPath: opts.envPath } : {})
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
