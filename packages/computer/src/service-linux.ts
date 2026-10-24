import { execFile, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// systemd user unit tied to the graphical session, so it starts at login with the session's display and D-Bus.
export const UNIT = 'agentconnect-computer.service'
export const unitPath = (): string =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user', UNIT)

export const SESSION_VARS = [
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS'
]
// The logind session the service was started for; the daemon exits when that session ends (computer-use.md §3.3).
export const SESSION_ENV = 'AGENTCONNECT_COMPUTER_SESSION'
// What a finished session leaves behind in the manager; the bus and runtime dir belong to the user, not the session.
const SESSION_DISPLAY_VARS = ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', SESSION_ENV]
/** Exit status that makes systemd restart the service in the newer session it now has (Restart=on-failure). */
export const EXIT_NEW_SESSION = 75

// Desktops such as Xfce never activate graphical-session.target, so an XDG autostart entry starts the unit at login.
export const autostartPath = (): string =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart', 'agentconnect-computer.desktop')

function systemctl(...args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' })
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

const quote = (value: string): string => `"${value.replace(/(["\\])/g, '\\$1')}"`

// ExecCondition: outside a desktop session there is no display, so the start is skipped instead of crash-looping.
export function unitFile(node: string, script: string): string {
  return `[Unit]
Description=AgentConnect Computer (computer-use daemon)
PartOf=graphical-session.target
After=graphical-session.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
ExecCondition=/bin/sh -c 'test -n "$DISPLAY$WAYLAND_DISPLAY"'
ExecStart=${quote(node)} ${quote(script)} run
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
`
}

// At login: hand the session to systemd, clear a start limit an earlier session hit, then start the unit.
export function autostartEntry(): string {
  const steps = [
    `systemctl --user import-environment ${SESSION_VARS.join(' ')}`,
    `systemctl --user set-environment ${SESSION_ENV}=$XDG_SESSION_ID`,
    `systemctl --user reset-failed ${UNIT}`,
    `systemctl --user start ${UNIT}`
  ]
  return `[Desktop Entry]
Type=Application
Name=AgentConnect Computer
Comment=Starts the AgentConnect Computer service in this desktop session
Exec=sh -c '${steps.join('; ')}'
NoDisplay=true
X-GNOME-Autostart-enabled=true
`
}

// A managed (version store) entry is already stable; any other bundle is copied under the data dir so moving it never breaks the unit.
export function installService(dataDir: string, script: string, managed = false): void {
  let target = script
  if (!managed) {
    const app = join(dataDir, 'app')
    mkdirSync(app, { recursive: true })
    target = join(app, 'agentconnect-computer.mjs')
    if (script !== target) copyFileSync(script, target)
  }
  mkdirSync(join(unitPath(), '..'), { recursive: true })
  writeFileSync(unitPath(), unitFile(process.execPath, target))
  mkdirSync(join(autostartPath(), '..'), { recursive: true })
  writeFileSync(autostartPath(), autostartEntry())
  systemctl('daemon-reload')
  const enabled = systemctl('enable', UNIT)
  if (!enabled.ok) throw new Error(`systemctl --user enable failed: ${enabled.output}`)
  // Inside a session, hand its display to systemd and (re)start now; over SSH it only starts at the next login.
  if (inGraphicalSession()) {
    systemctl('import-environment', ...SESSION_VARS.filter((name) => process.env[name]))
    // A terminal can carry an SSH login's session id; only a graphical session is worth following.
    const session = process.env.XDG_SESSION_ID
    if (session && graphicalSessionSync(session)) systemctl('set-environment', `${SESSION_ENV}=${session}`)
    else systemctl('unset-environment', SESSION_ENV)
    systemctl('reset-failed', UNIT)
    systemctl('restart', UNIT)
  }
}

const GRAPHICAL_TYPES = new Set(['x11', 'wayland', 'mir'])

function graphicalSessionSync(id: string): boolean {
  const type = spawnSync('loginctl', ['show-session', id, '-p', 'Type', '--value'], { encoding: 'utf8' })
  return type.status === 0 && GRAPHICAL_TYPES.has(type.stdout.trim())
}

export const inGraphicalSession = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)

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

/** A probe answer; undefined when loginctl could not say (timeout, bus hiccup), which is never an ending. */
export type Answer = boolean | undefined

export interface SessionProbe {
  /** Whether logind knows this session as a graphical one (x11, wayland); null when the session is already gone. */
  graphical(id: string): Promise<Answer | null>
  /** Whether logind still has this session open; a closing or unknown-to-logind session counts as ended. */
  live(id: string): Promise<Answer>
  /** The session the manager would start the unit for now. */
  managerSession(): Promise<string | undefined>
  /** Drops this session's display from the manager, so no later start finds a dead one. */
  forget(id: string): Promise<void>
}

interface RunResult {
  ok: boolean
  /** The command ran to a non-zero exit, as opposed to timing out or failing to spawn. */
  exited: boolean
  stdout: string
  stderr: string
}

const run = (command: string, args: string[]): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', timeout: 10_000 }, (error, stdout, stderr) =>
      resolve({
        ok: !error,
        exited: Boolean(error) && typeof error?.code === 'number' && !error.killed,
        stdout: stdout ?? '',
        stderr: stderr ?? ''
      })
    )
  })

const environmentValue = (output: string, name: string): string | undefined =>
  new RegExp(`^${name}=(.*)$`, 'm').exec(output)?.[1]?.trim() || undefined

// loginctl's own answer that a session is gone, as opposed to failing to ask.
const GONE = /no session|not known|does not exist/i

/** Reads `loginctl show-session -p <property>`; undefined when logind could not be asked, null when the session is gone. */
export async function sessionProperty(id: string, property: string, exec = run): Promise<string | null | undefined> {
  const result = await exec('loginctl', ['show-session', id, '-p', property, '--value'])
  if (result.ok) return result.stdout.trim() || undefined
  return result.exited && GONE.test(result.stderr) ? null : undefined
}

export const logindProbe: SessionProbe = {
  async graphical(id) {
    const type = await sessionProperty(id, 'Type')
    return type == null ? type : GRAPHICAL_TYPES.has(type)
  },
  async live(id) {
    const state = await sessionProperty(id, 'State')
    return state === undefined ? undefined : state !== null && state !== 'closing'
  },
  async managerSession() {
    const env = await run('systemctl', ['--user', 'show-environment'])
    return env.ok ? environmentValue(env.stdout, SESSION_ENV) : undefined
  },
  async forget(id) {
    // Only while the manager still names this session: a newer login may have imported its own display already.
    if ((await this.managerSession()) !== id) return
    await run('systemctl', ['--user', 'unset-environment', ...SESSION_DISPLAY_VARS])
  }
}

/** Consecutive unanswered probes after which a session counts as gone; one timeout never ends it. */
export const UNKNOWN_LIMIT = 3

// Xfce never stops graphical-session.target, so the service watches its logind session and leaves with it.
export function watchSession(options: {
  session: string
  onEnded: (exitCode: number, reason: string) => void
  /** Told when the named session is not a graphical one, which is then not followed. */
  onIgnored?: (reason: string) => void
  probe?: SessionProbe
  intervalMs?: number
}): () => void {
  const probe = options.probe ?? logindProbe
  let stopped = false
  let busy = false
  let checked = false
  let unknown = 0
  const tick = async (): Promise<void> => {
    if (stopped || busy) return
    busy = true
    try {
      if (!checked) {
        const graphical = await probe.graphical(options.session)
        // Unanswered: ask again next tick rather than stop following for good.
        if (graphical === undefined) return
        checked = true
        // Already gone, as after a logout before a restart: take the end path rather than run unwatched.
        if (graphical === null) return await end()
        if (!graphical) {
          stop()
          options.onIgnored?.(`session ${options.session} is not a graphical session; not following it`)
          return
        }
      }
      const live = await probe.live(options.session)
      if (live === true) unknown = 0
      if (live === true || (live === undefined && ++unknown < UNKNOWN_LIMIT)) return
      await end()
    } finally {
      busy = false
    }
  }
  const end = async (): Promise<void> => {
    const next = await probe.managerSession()
    if (next && next !== options.session && (await probe.live(next)) === true) {
      stop()
      options.onEnded(EXIT_NEW_SESSION, `desktop session ${options.session} ended; restarting in session ${next}`)
      return
    }
    await probe.forget(options.session)
    stop()
    options.onEnded(0, `desktop session ${options.session} ended`)
  }
  const timer = setInterval(() => void tick(), options.intervalMs ?? 5000)
  timer.unref()
  const stop = (): void => {
    stopped = true
    clearInterval(timer)
  }
  return stop
}
