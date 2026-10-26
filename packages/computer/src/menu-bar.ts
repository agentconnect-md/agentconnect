// The macOS menu bar's model and actions (#3403): the daemon decides every item, the Swift helper only draws and clicks.
import type { Check } from './setup.js'
import type { TrayState, TrayTone } from './linux/tray.js'
import { HelperTray } from './tray-helper.js'

export type Mark = 'ok' | 'fail' | 'warn' | 'progress'

export interface MenuItem {
  id?: string
  title: string
  mark?: Mark
  checked?: boolean
  enabled?: boolean
  separator?: boolean
  // The helper asks before it reports the click.
  confirm?: { title: string; message: string; button: string }
}

export interface Menu {
  tone: TrayTone
  tooltip: string
  items: MenuItem[]
}

export type ControlPlaneState = 'connected' | 'connecting' | 'disconnected' | 'revoked' | 'unregistered'

// What the menu shows besides the agent state; refreshed when the menu opens and after each action.
export interface MenuBarFacts {
  name?: string
  version: string
  appVersion?: string
  controlPlane: { state: ControlPlaneState; host?: string }
  // Undefined while unknown: the driver did not answer.
  screenRecording?: boolean
  accessibility?: boolean
  driver: { version: string; running: boolean }
  ffmpeg: { version: string; installed: boolean; installable: boolean; installing?: boolean }
  startAtLogin: boolean
}

export type Busy = 'driver' | 'ffmpeg' | 'control-plane'

const CONTROL_PLANE: Record<ControlPlaneState, [Mark, string]> = {
  connected: ['ok', 'connected'],
  connecting: ['progress', 'connecting…'],
  disconnected: ['fail', 'disconnected, click to retry'],
  revoked: ['fail', 'revoked, add this Mac again in the console'],
  unregistered: ['fail', 'not registered']
}

const grant = (label: string, granted: boolean | undefined, id: string): MenuItem =>
  granted === undefined
    ? { id, title: `${label}: unknown, click to open Settings`, mark: 'warn' }
    : granted
      ? { id, title: `${label}: allowed`, mark: 'ok' }
      : { id, title: `${label}: not allowed, click to open Settings`, mark: 'fail' }

export function menuBarMenu(tray: TrayState, facts: MenuBarFacts, busy: ReadonlySet<Busy> = new Set()): Menu {
  const [cpMark, cpText] = busy.has('control-plane')
    ? CONTROL_PLANE.connecting
    : CONTROL_PLANE[facts.controlPlane.state]
  const driver: MenuItem = busy.has('driver')
    ? { title: `Cua Driver ${facts.driver.version}: installing…`, mark: 'progress', enabled: false }
    : facts.driver.running
      ? { id: 'cua-driver', title: `Cua Driver ${facts.driver.version}: running`, mark: 'ok', enabled: false }
      : { id: 'cua-driver', title: `Cua Driver ${facts.driver.version}: not running, click to reinstall`, mark: 'fail' }
  const ffmpeg: MenuItem =
    busy.has('ffmpeg') || facts.ffmpeg.installing
      ? { title: `ffmpeg ${facts.ffmpeg.version}: downloading…`, mark: 'progress', enabled: false }
      : facts.ffmpeg.installed
        ? { id: 'ffmpeg', title: `ffmpeg ${facts.ffmpeg.version}: installed`, mark: 'ok', enabled: false }
        : facts.ffmpeg.installable
          ? { id: 'ffmpeg', title: `ffmpeg ${facts.ffmpeg.version}: not installed, click to install`, mark: 'fail' }
          : { title: 'ffmpeg: not found, the viewer falls back to screenshots', mark: 'warn', enabled: false }
  const version = facts.appVersion ? `Version ${facts.version} (app ${facts.appVersion})` : `Version ${facts.version}`
  return {
    tone: tray.tone,
    tooltip: `AgentConnect Computer: ${tray.status}`,
    items: [
      { title: facts.name ? `AgentConnect Computer · ${facts.name}` : 'AgentConnect Computer', enabled: false },
      { title: `Agents: ${tray.status}`, enabled: false },
      tray.canResume
        ? { id: 'resume', title: 'Resume Agent Input' }
        : { id: 'stop', title: 'Stop All Agent Input', enabled: tray.canStop },
      { title: '', separator: true },
      {
        id: 'control-plane',
        title: `Control Plane${facts.controlPlane.host ? ` (${facts.controlPlane.host})` : ''}: ${cpText}`,
        mark: cpMark,
        enabled: cpMark === 'fail' && facts.controlPlane.state !== 'revoked'
      },
      grant('Screen Recording', facts.screenRecording, 'screen-recording'),
      grant('Device Control (Accessibility)', facts.accessibility, 'accessibility'),
      driver,
      ffmpeg,
      { title: '', separator: true },
      { id: 'start-at-login', title: 'Start at Login', checked: facts.startAtLogin },
      { id: 'logs', title: 'Open Logs' },
      { title: version, enabled: false },
      { title: '', separator: true },
      {
        id: 'uninstall',
        title: 'Uninstall…',
        confirm: {
          title: 'Uninstall AgentConnect Computer?',
          message:
            'Terminal opens and runs the uninstaller: it stops the service and removes the app. Your Computer key and settings stay unless you run it with --purge.',
          button: 'Uninstall'
        }
      },
      {
        id: 'quit',
        title: 'Quit AgentConnect Computer',
        confirm: {
          title: 'Quit AgentConnect Computer?',
          message: 'Agents cannot use this Mac until it starts again at your next login.',
          button: 'Quit'
        }
      }
    ]
  }
}

// The daemon side of each item; every action runs in the daemon, so the helper holds no grants and no logic.
export interface MenuBarHost {
  facts(): Promise<MenuBarFacts>
  stop(): void
  resume(): void
  // Resolves whether the channel came back within the wait.
  reconnect(): Promise<boolean>
  installDriver(): Promise<void>
  installFfmpeg(): Promise<void>
  openSettings(pane: 'screenRecording' | 'accessibility'): void
  setStartAtLogin(on: boolean): void
  openLogs(): void
  uninstall(): void
  quit(): void
  restart(): void
  log(line: string): void
}

export interface MenuBar {
  update(tray: TrayState): void
  checks(): Check[]
  close(): void
}

export function startMenuBar(
  helper: string,
  host: MenuBarHost,
  initial: TrayState,
  start: typeof HelperTray.start = HelperTray.start
): MenuBar {
  let tray = initial
  let facts: MenuBarFacts | undefined
  const busy = new Set<Busy>()
  const render = (): void => {
    if (facts) helperTray.update(menuBarMenu(tray, facts, busy))
  }
  const refresh = (): Promise<void> =>
    host.facts().then(
      (fresh) => {
        facts = fresh
        render()
      },
      (error: Error) => host.log(`menu bar: cannot read the status: ${error.message}`)
    )
  // One install or reconnect at a time per item; the menu shows it in progress meanwhile.
  const task = (kind: Busy, run: () => Promise<unknown>): void => {
    if (busy.has(kind)) return
    busy.add(kind)
    render()
    void run()
      .catch((error: Error) => host.log(`menu bar: ${kind}: ${error.message}`))
      .finally(() => {
        busy.delete(kind)
        void refresh()
      })
  }
  const click = (id: string): void => {
    switch (id) {
      case 'stop':
        return host.stop()
      case 'resume':
        return host.resume()
      case 'control-plane':
        return task('control-plane', async () => {
          if (!(await host.reconnect())) host.openLogs()
        })
      case 'screen-recording':
        return host.openSettings('screenRecording')
      case 'accessibility':
        return host.openSettings('accessibility')
      case 'cua-driver':
        return task('driver', () => host.installDriver())
      case 'ffmpeg':
        return task('ffmpeg', () => host.installFfmpeg())
      case 'start-at-login':
        host.setStartAtLogin(!(facts?.startAtLogin ?? true))
        return void refresh()
      case 'logs':
        return host.openLogs()
      case 'uninstall':
        return host.uninstall()
      case 'quit':
        return host.quit()
    }
  }
  const helperTray = start(helper, {
    onClick: click,
    onMenuOpen: () => void refresh(),
    onRestart: () => {
      host.log('macOS asked AgentConnect Computer to quit; restarting the service')
      host.restart()
    },
    log: host.log
  })
  void refresh()
  return {
    update(state) {
      tray = state
      render()
    },
    checks() {
      const problem = helperTray.problem
      return [
        problem
          ? {
              name: 'tray',
              status: 'warn',
              detail: `${problem}: no local indicator; stop agents with agentconnect-computer pause`,
              fix: 'restart the service: agentconnect-computer service restart'
            }
          : { name: 'tray', status: 'ok', detail: 'the menu bar icon shows agent control and can stop it' }
      ]
    },
    close: () => helperTray.close()
  }
}
