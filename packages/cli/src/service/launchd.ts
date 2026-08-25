/** macOS launchd controller. Writes a LaunchAgent plist that runs
 *  `<node> <cli-entry> run --root <root>` (the CLI run shell; legacy fallback is
 *  the daemon's `<root>/current/dist/index.js`), and drives it with `launchctl
 *  bootstrap/bootout` (falling back to legacy `load/unload` on older macOS). */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { currentDistEntry, daemonLogPath, defaultRoot, logsDir } from '../paths.js'
import type { ControllerDeps, InstalledUnit, InstallOpts, ServiceController, ServiceStatus } from './types.js'

const DEFAULT_LABEL = 'md.agentconnect.daemon'

/** `md.agentconnect.daemon` for the default instance, suffixed with `.<name>`
 *  for a named one, so each instance owns its own LaunchAgent. */
export function launchdLabel(instance?: string): string {
  return instance ? `${DEFAULT_LABEL}.${instance}` : DEFAULT_LABEL
}

export function launchAgentsDir(home: string): string {
  return join(home, 'Library', 'LaunchAgents')
}

const LAUNCHD_PLIST_PATTERN = /^md\.agentconnect\.daemon(?:\.([a-z0-9][a-z0-9_-]*))?\.plist$/

/** The root a written agent runs against: the `--root` we bake into
 *  ProgramArguments, else `AGENTCONNECT_ROOT`, else the default (legacy agent). */
export function parsePlistRoot(text: string): string {
  const arg = /<string>--root<\/string>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
  if (arg) return unxml(arg)
  const env = /<key>AGENTCONNECT_ROOT<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
  return env ? unxml(env) : defaultRoot()
}

function unxml(v: string): string {
  return v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** Every AgentConnect LaunchAgent on this host, default instance included. */
export function scanLaunchAgents(home: string): InstalledUnit[] {
  const dir = launchAgentsDir(home)
  if (!existsSync(dir)) return []
  const found: InstalledUnit[] = []
  for (const name of readdirSync(dir).sort()) {
    const match = LAUNCHD_PLIST_PATTERN.exec(name)
    if (!match) continue
    const unitPath = join(dir, name)
    let text = ''
    try {
      text = readFileSync(unitPath, 'utf8')
    } catch {
      continue // unreadable agent — nothing useful to report about it
    }
    found.push({
      ...(match[1] ? { instance: match[1] } : {}),
      label: name.replace(/\.plist$/, ''),
      unitPath,
      root: parsePlistRoot(text)
    })
  }
  // Default instance first, then named ones alphabetically — the order the
  // `instances` listing reads best in.
  return found.sort((a, b) => (a.instance ?? '').localeCompare(b.instance ?? ''))
}

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
  // `--root` is explicit in the args, not left to inherited env: the run shell
  // launches the daemon through the user's interactive login shell, so a profile
  // exporting AGENTCONNECT_ROOT would otherwise drag this instance onto another
  // instance's root (and its lock, sqlite, socket). The flag beats env.
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
    <string>--root</string>
    <string>${xml(a.root)}</string>
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
  readonly label: string
  private readonly plistPath: string

  constructor(private readonly deps: ControllerDeps) {
    this.label = launchdLabel(deps.instance)
    this.plistPath = join(launchAgentsDir(deps.home), `${this.label}.plist`)
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
      label: this.label,
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
    const r = await this.deps.exec('launchctl', ['bootout', `gui/${this.deps.uid}/${this.label}`])
    if (r.code !== 0) {
      await this.deps.exec('launchctl', ['unload', '-w', this.plistPath])
    }
  }

  async status(): Promise<ServiceStatus> {
    const logPath = daemonLogPath(this.deps.root)
    if (!this.isInstalled()) return { installed: false, running: false, label: this.label, logPath }
    const r = await this.deps.exec('launchctl', ['print', `gui/${this.deps.uid}/${this.label}`])
    const running = r.code === 0
    const pidMatch = /\bpid = (\d+)/.exec(r.stdout)
    return {
      installed: true,
      running,
      ...(pidMatch ? { pid: Number(pidMatch[1]) } : {}),
      label: this.label,
      logPath
    }
  }
}
