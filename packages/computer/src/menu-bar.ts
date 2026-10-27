// The macOS menu bar's and Windows taskbar icon's model and actions (#3403): the daemon decides every item, the helper only draws and clicks.
import type { ComputerAdminPromptMode } from '@agentconnect.md/protocol/computer'
import type { Grant } from './macos-grants.js'
import type { Check } from './setup.js'
import type { TrayState, TrayTone } from './linux/tray.js'
import { HelperTray } from './tray-helper.js'
import type { FirewallVerdict } from './windows-firewall.js'

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
  // A submenu; only the Windows taskbar helper draws one.
  items?: MenuItem[]
}

// The corner badge: paused outranks agent control, which outranks a failing check.
export type Badge = 'paused' | 'busy' | 'error'

export interface Menu {
  tone: TrayTone
  badge?: Badge
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
  screenRecording?: GrantState
  accessibility?: GrantState
  driver: { version: string; running: boolean }
  ffmpeg: { version: string; installed: boolean; installable: boolean; installing?: boolean }
  startAtLogin: boolean
  // Set on Windows, where the service replaces the macOS grants: whether it runs the daemon, and its UAC prompts.
  windows?: { service: boolean; adminPrompts?: AdminPromptFacts; firewall?: FirewallVerdict['state'] }
}

// Who answers UAC prompts (computer-use.md §4.2.1), set here or in the console; a registered desktop needs its Control Plane to change it.
export interface AdminPromptFacts {
  mode: ComputerAdminPromptMode
  editable: boolean
  // Why it cannot be changed here now.
  locked?: string
  // The app a prompt waiting now names.
  pending?: string
  // Why prompts cannot be watched.
  problem?: string
}

// `stale`: once held, now not in effect: switched off, or held by an earlier ad-hoc build of the app.
export type GrantState = 'allowed' | 'off' | 'stale'

export type Busy = 'driver' | 'ffmpeg' | 'control-plane' | 'admin-prompts' | 'firewall'

const FACTS_REFRESH_MS = 30_000

const controlPlaneText = (machine: string): Record<ControlPlaneState, [Mark, string]> => ({
  connected: ['ok', 'connected'],
  connecting: ['progress', 'connecting…'],
  disconnected: ['fail', 'disconnected, click to retry'],
  revoked: ['fail', `revoked, add this ${machine} again in the console`],
  unregistered: ['fail', 'not registered']
})

// The order the taskbar and the console list the modes in.
export const ADMIN_PROMPT_LABELS: Record<ComputerAdminPromptMode, string> = {
  people: 'People Approve Each One',
  agent: 'Agent Decides',
  approve: 'Always Approve',
  deny: 'Always Deny'
}

const FIREWALL_PROBLEM: Record<Exclude<FirewallVerdict['state'], 'allowed'>, string> = {
  missing: 'no rule for direct video',
  blocked: 'blocks direct video',
  uncovered: 'blocks direct video on this network'
}

// Whether the console's viewer can reach this computer's WebRTC media directly; undefined while the rules cannot be read.
const firewallRow = (state: FirewallVerdict['state'] | undefined, busy: boolean): MenuItem =>
  busy
    ? { title: 'Windows Firewall: adding the rule…', mark: 'progress', enabled: false }
    : state === 'allowed'
      ? { title: 'Windows Firewall: direct video allowed', mark: 'ok', enabled: false }
      : state === undefined
        ? { title: 'Windows Firewall: cannot read the rules', mark: 'warn', enabled: false }
        : {
            id: 'firewall',
            title: `Windows Firewall: ${FIREWALL_PROBLEM[state]}, click to allow`,
            mark: 'fail'
          }

// Windows rows in place of the macOS grants: the service, its firewall rule, and who answers UAC prompts.
const windowsRows = (
  { service, adminPrompts, firewall }: NonNullable<MenuBarFacts['windows']>,
  busy: ReadonlySet<Busy>
): MenuItem[] => {
  if (!service)
    return [
      { title: 'Service: not installed, run agentconnect computer setup', mark: 'warn', enabled: false },
      { title: 'Administrator prompts: out of reach without the service', mark: 'warn', enabled: false }
    ]
  const rows: MenuItem[] = [
    { title: 'Service: running as SYSTEM', mark: 'ok', enabled: false },
    firewallRow(firewall, busy.has('firewall'))
  ]
  if (!adminPrompts) return rows
  if (adminPrompts.problem)
    rows.push({ title: `Administrator prompts: ${adminPrompts.problem}`, mark: 'fail', enabled: false })
  if (adminPrompts.pending)
    rows.push({ title: `Administrator prompt waiting: ${adminPrompts.pending}`, mark: 'warn', enabled: false })
  const modes = Object.entries(ADMIN_PROMPT_LABELS) as Array<[ComputerAdminPromptMode, string]>
  rows.push({
    title: `Administrator Prompts: ${busy.has('admin-prompts') ? 'saving…' : ADMIN_PROMPT_LABELS[adminPrompts.mode]}`,
    items: [
      ...modes.map(([mode, title]) => ({
        id: `admin-prompts:${mode}`,
        title,
        checked: mode === adminPrompts.mode,
        enabled: adminPrompts.editable && !busy.has('admin-prompts')
      })),
      ...(adminPrompts.locked
        ? [
            { title: '', separator: true },
            { title: adminPrompts.locked, enabled: false }
          ]
        : [])
    ]
  })
  return rows
}

const grant = (label: string, state: GrantState | undefined, id: string): MenuItem =>
  state === undefined
    ? { id, title: `${label}: unknown, click to open Settings`, mark: 'warn' }
    : state === 'allowed'
      ? { id, title: `${label}: allowed`, mark: 'ok' }
      : state === 'stale'
        ? { id: `reset-${id}`, title: `${label}: not in effect, click to reset and allow again`, mark: 'fail' }
        : { id, title: `${label}: not allowed, click to open Settings`, mark: 'fail' }

export function menuBarMenu(tray: TrayState, facts: MenuBarFacts, busy: ReadonlySet<Busy> = new Set()): Menu {
  const windows = facts.windows
  const states = controlPlaneText(windows ? 'computer' : 'Mac')
  const [cpMark, cpText] = busy.has('control-plane') ? states.connecting : states[facts.controlPlane.state]
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
  const items: MenuItem[] = [
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
    ...(windows
      ? windowsRows(windows, busy)
      : [
          grant('Screen Recording', facts.screenRecording, 'screen-recording'),
          grant('Device Control (Accessibility)', facts.accessibility, 'accessibility')
        ]),
    driver,
    ffmpeg,
    { title: '', separator: true },
    { id: 'start-at-login', title: windows ? 'Start at Sign-in' : 'Start at Login', checked: facts.startAtLogin },
    { id: 'logs', title: 'Open Logs' },
    { title: version, enabled: false },
    { title: '', separator: true },
    {
      id: 'uninstall',
      title: 'Uninstall…',
      confirm: {
        title: 'Uninstall AgentConnect Computer?',
        message: windows
          ? 'A console window opens and runs the uninstaller; approve its administrator prompt. It removes the service and the app. Your Computer key and settings stay unless you run it with --purge.'
          : 'Terminal opens and runs the uninstaller: it stops the service and removes the app. Your Computer key and settings stay unless you run it with --purge.',
        button: 'Uninstall'
      }
    },
    {
      id: 'quit',
      title: 'Quit AgentConnect Computer',
      confirm: {
        title: 'Quit AgentConnect Computer?',
        message: windows
          ? 'Agents cannot use this computer until it starts again at your next sign-in.'
          : 'Agents cannot use this Mac until it starts again at your next login.',
        button: 'Quit'
      }
    }
  ]
  const failing = items.some((item) => item.mark === 'fail')
  const badge: Badge | undefined =
    tray.tone === 'paused' ? 'paused' : tray.tone === 'busy' ? 'busy' : failing ? 'error' : undefined
  return {
    tone: tray.tone,
    ...(badge ? { badge } : {}),
    tooltip: `AgentConnect Computer: ${tray.status}${failing ? '; something needs attention, open the menu' : ''}`,
    items
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
  openSettings(pane: Grant): void
  // Forgets a grant macOS holds for an earlier build, then asks for it again.
  resetGrant(grant: Grant): void
  setStartAtLogin(on: boolean): void
  // Windows: who answers UAC prompts, stored where the console reads it too.
  setAdminPrompts?(mode: ComputerAdminPromptMode): Promise<void>
  // Windows: the inbound rule the viewer's direct WebRTC media needs.
  allowFirewall?(): Promise<void>
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
  let reading: Promise<void> | undefined
  const refresh = (): Promise<void> =>
    (reading ??= host
      .facts()
      .then(
        (fresh) => {
          facts = fresh
          render()
        },
        (error: Error) => host.log(`menu bar: cannot read the status: ${error.message}`)
      )
      .finally(() => {
        reading = undefined
      }))
  // A check can fail with nobody opening the menu, and the icon's error badge must show it anyway.
  const recheck = setInterval(() => void refresh(), FACTS_REFRESH_MS)
  recheck.unref()
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
    const mode = /^admin-prompts:(.+)$/.exec(id)?.[1] as ComputerAdminPromptMode | undefined
    if (mode && mode in ADMIN_PROMPT_LABELS && host.setAdminPrompts)
      return task('admin-prompts', () => host.setAdminPrompts!(mode))
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
      case 'reset-screen-recording':
        return host.resetGrant('screenRecording')
      case 'reset-accessibility':
        return host.resetGrant('accessibility')
      case 'cua-driver':
        return task('driver', () => host.installDriver())
      case 'ffmpeg':
        return task('ffmpeg', () => host.installFfmpeg())
      case 'firewall':
        return host.allowFirewall && task('firewall', () => host.allowFirewall!())
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
          : {
              name: 'tray',
              status: 'ok',
              detail: `the ${process.platform === 'win32' ? 'taskbar' : 'menu bar'} icon shows agent control and can stop it`
            }
      ]
    },
    close() {
      clearInterval(recheck)
      helperTray.close()
    }
  }
}
