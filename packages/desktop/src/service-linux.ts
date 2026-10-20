import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// systemd user unit tied to the graphical session, so it starts at login with the session's display and D-Bus.
export const UNIT = 'agentconnect-desktop.service'
export const unitPath = (): string =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user', UNIT)

const SESSION_VARS = [
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS'
]

// Desktops such as Xfce never activate graphical-session.target, so an XDG autostart entry starts the unit at login.
export const autostartPath = (): string =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart', 'agentconnect-desktop.desktop')

function systemctl(...args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' })
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

const quote = (value: string): string => `"${value.replace(/(["\\])/g, '\\$1')}"`

// Copies the bundle to a stable path under the data dir, so moving the unzipped folder never breaks the unit.
export function installService(dataDir: string, script: string): void {
  const app = join(dataDir, 'app')
  mkdirSync(app, { recursive: true })
  const target = join(app, 'agentconnect-desktop.mjs')
  if (script !== target) copyFileSync(script, target)
  // ExecCondition: outside a desktop session there is no display, so the start is skipped instead of crash-looping.
  const unit = `[Unit]
Description=AgentConnect Desktop (computer-use daemon)
PartOf=graphical-session.target
After=graphical-session.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
ExecCondition=/bin/sh -c 'test -n "$DISPLAY$WAYLAND_DISPLAY"'
ExecStart=${quote(process.execPath)} ${quote(target)} run
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
`
  mkdirSync(join(unitPath(), '..'), { recursive: true })
  writeFileSync(unitPath(), unit)
  mkdirSync(join(autostartPath(), '..'), { recursive: true })
  writeFileSync(
    autostartPath(),
    `[Desktop Entry]
Type=Application
Name=AgentConnect Desktop
Comment=Starts the AgentConnect Desktop service in this desktop session
Exec=sh -c 'systemctl --user import-environment ${SESSION_VARS.join(' ')}; systemctl --user start ${UNIT}'
NoDisplay=true
X-GNOME-Autostart-enabled=true
`
  )
  systemctl('daemon-reload')
  const enabled = systemctl('enable', UNIT)
  if (!enabled.ok) throw new Error(`systemctl --user enable failed: ${enabled.output}`)
  // Inside a session, hand its display to systemd and (re)start now; over SSH it only starts at the next login.
  const inSession = SESSION_VARS.slice(0, 3).some((name) => process.env[name])
  if (inSession) {
    systemctl('import-environment', ...SESSION_VARS.filter((name) => process.env[name]))
    systemctl('restart', UNIT)
  }
}

export function startService(): void {
  const result = systemctl('start', UNIT)
  if (!result.ok) throw new Error(`systemctl --user start failed: ${result.output}`)
}

export function stopService(): void {
  systemctl('stop', UNIT)
}

export function restartService(): void {
  const result = systemctl('restart', UNIT)
  if (!result.ok) throw new Error(`systemctl --user restart failed: ${result.output}`)
}

export function uninstallService(): void {
  systemctl('disable', '--now', UNIT)
  rmSync(unitPath(), { force: true })
  rmSync(autostartPath(), { force: true })
  systemctl('daemon-reload')
}

export function serviceStatus(): { installed: boolean; loaded: boolean; pid?: number; state?: string } {
  const show = systemctl('show', UNIT, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID')
  const field = (name: string): string | undefined => new RegExp(`^${name}=(.*)$`, 'm').exec(show.output)?.[1]
  const pid = Number(field('MainPID'))
  return {
    installed: field('LoadState') === 'loaded',
    loaded: field('ActiveState') === 'active',
    ...(pid ? { pid } : {}),
    state: `${field('ActiveState')}/${field('SubState')}`
  }
}
