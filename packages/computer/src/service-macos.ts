import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Per-user LaunchAgent: runs `run` inside the GUI (Aqua) session, so the .app itself holds the TCC grants.
export const SERVICE_LABEL = 'md.agentconnect.computer'
export const plistPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
const domain = (): string => `gui/${process.getuid!()}`

const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function launchctl(...args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' })
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

// Whether someone is logged in to this Mac's desktop: only then does the GUI launchd domain exist.
export const guiSession = (): boolean => launchctl('print', domain()).ok

// `program run` (the app's Node plus the store's stable entry); NODE_OPTIONS is cleared so `launchctl setenv` cannot inject code.
export function servicePlist(program: string[], logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>${[...program, 'run'].map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
  <key>AssociatedBundleIdentifiers</key><array><string>${SERVICE_LABEL}</string></array>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
  <key>EnvironmentVariables</key><dict><key>NODE_OPTIONS</key><string></string></dict>
</dict>
</plist>
`
}

// Returns whether the service started; without a desktop login it starts at the next one (RunAtLoad).
export function installService(program: string[], logPath: string): boolean {
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  stopService()
  writeFileSync(plistPath(), servicePlist(program, logPath))
  if (!guiSession()) return false
  startService()
  return true
}

export function startService(): void {
  if (serviceStatus().loaded) return
  if (!guiSession()) throw new Error("nobody is logged in to this Mac's desktop: the service starts at the next login")
  // The menu bar's "Start at Login" may have disabled it, and launchd refuses to bootstrap a disabled job.
  setStartAtLogin(true)
  const result = launchctl('bootstrap', domain(), plistPath())
  if (!result.ok) throw new Error(`launchctl bootstrap failed: ${result.output}`)
}

export function stopService(): void {
  if (!serviceStatus().loaded) return
  launchctl('bootout', `${domain()}/${SERVICE_LABEL}`)
  // bootout returns while launchd is still tearing the job down.
  const deadline = Date.now() + 10_000
  while (serviceStatus().loaded && Date.now() < deadline) spawnSync('sleep', ['0.2'])
}

// Restarting is how a new Screen Recording grant reaches the daemon.
export function restartService(): void {
  const result = launchctl('kickstart', '-k', `${domain()}/${SERVICE_LABEL}`)
  if (!result.ok) throw new Error(`launchctl kickstart failed: ${result.output}`)
}

export function uninstallService(): void {
  stopService()
  rmSync(plistPath(), { force: true })
}

export function serviceStatus(): { installed: boolean; loaded: boolean; pid?: number; state?: string } {
  const installed = existsSync(plistPath())
  const result = launchctl('print', `${domain()}/${SERVICE_LABEL}`)
  if (!result.ok) return { installed, loaded: false }
  const pid = /^\s*pid = (\d+)/m.exec(result.output)?.[1]
  const state = /^\s*state = (\S+)/m.exec(result.output)?.[1]
  return { installed, loaded: true, ...(pid ? { pid: Number(pid) } : {}), ...(state ? { state } : {}) }
}

// Whether launchd starts the service at login; disabling it leaves a running daemon running.
export function startsAtLogin(): boolean {
  if (!existsSync(plistPath())) return false
  const disabled = launchctl('print-disabled', domain()).output
  // Older macOS prints `=> true` for a disabled job.
  return ![`"${SERVICE_LABEL}" => disabled`, `"${SERVICE_LABEL}" => true`].some((line) => disabled.includes(line))
}

export function setStartAtLogin(on: boolean): void {
  launchctl(on ? 'enable' : 'disable', `${domain()}/${SERVICE_LABEL}`)
}
