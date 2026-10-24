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

export function installService(executable: string, logPath: string): void {
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(executable)}</string><string>run</string></array>
  <key>AssociatedBundleIdentifiers</key><array><string>${SERVICE_LABEL}</string></array>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`
  stopService()
  writeFileSync(plistPath(), plist)
  startService()
}

export function startService(): void {
  if (serviceStatus().loaded) return
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
