// The owner's local indicator and stop on the desktop itself (computer-use.md §6): tray, stop hotkey, keyboard activity.
import type { Check } from './setup.js'
import { X11LocalControls, parseHotkey, type Hotkey } from './linux/x11-local.js'
import { Tray, type TrayState } from './linux/tray.js'

export const TRAY_STOP_REASON = 'stopped from the tray'
export const HOTKEY_STOP_REASON = 'stopped with the stop hotkey'
export const LOCAL_OWNER_STOP_REASON = 'stopped by the local owner'
export const DAEMON_CONSOLE_STOP_REASON = 'stopped from the daemon console'
// Pauses the owner made on this machine; only these may be lifted from the tray.
export const LOCAL_STOP_REASONS = new Set([
  TRAY_STOP_REASON,
  HOTKEY_STOP_REASON,
  LOCAL_OWNER_STOP_REASON,
  DAEMON_CONSOLE_STOP_REASON
])

export interface LocallyControlled {
  liveStatus(): 'online' | 'paused' | 'human_in_control' | 'busy'
  pauseReason(): string | undefined
  pause(reason: string): void
  resume(): void
  noteHumanInput(): void
  leaseActivity(): { holder: string } | undefined
}

export interface LocalControlsOptions {
  computer: LocallyControlled
  // Why the Control Plane's authority is missing, if it is.
  refusal: () => string | undefined
  stopHotkey: string
  // A virtual display (Xvfb) that no person watches.
  headless?: boolean
  log: (line: string) => void
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  startX11?: typeof X11LocalControls.start
  startTray?: typeof Tray.start
}

export interface LocalControls {
  // Whether human keyboard activity reaches the arbitration (capabilities: pointer+keyboard).
  keyboard(): boolean
  checks(): Check[]
  // Re-reads the Computer's state into the indicator.
  update(): void
  close(): void
}

/** The indicator's state from the Computer's. */
export function trayState(computer: LocallyControlled, refusal: string | undefined): TrayState {
  const live = computer.liveStatus()
  const reason = computer.pauseReason()
  const canResume = live === 'paused' && reason !== undefined && LOCAL_STOP_REASONS.has(reason)
  const flags = { canResume, canStop: live !== 'paused' }
  if (refusal) return { tone: 'unavailable', status: 'unavailable, agents cannot act', ...flags }
  if (live === 'busy') {
    return { tone: 'busy', status: `controlled by ${computer.leaseActivity()?.holder ?? 'an agent'}`, ...flags }
  }
  if (live === 'human_in_control') return { tone: 'paused', status: 'a console viewer is in control', ...flags }
  if (live === 'paused') return { tone: 'paused', status: `paused, ${reason ?? 'stopped'}`, ...flags }
  return { tone: 'online', status: 'ready, no agent in control', ...flags }
}

const TRAY_REFRESH_MS = 2000

// X11 only for now; Wayland (#3221) and other platforms get no local controls here yet.
export async function startLocalControls(options: LocalControlsOptions): Promise<LocalControls | undefined> {
  const env = options.env ?? process.env
  if ((options.platform ?? process.platform) !== 'linux' || !env.DISPLAY || env.WAYLAND_DISPLAY) return undefined
  const { computer, log } = options
  const hotkey: Hotkey | undefined = options.stopHotkey ? parseHotkey(options.stopHotkey) : undefined
  const hotkeyInvalid = options.stopHotkey && !hotkey ? `"${options.stopHotkey}" is not a valid hotkey` : undefined
  const stop = (reason: string): void => {
    // A viewer takeover ends too: the person at the machine outranks a remote one.
    if (computer.liveStatus() === 'paused') return
    computer.pause(reason)
    log(`PAUSED (${reason}): all agent input is blocked until the owner resumes`)
  }
  let x11: X11LocalControls | undefined
  let x11Problem: string | undefined
  try {
    x11 = await (options.startX11 ?? X11LocalControls.start)({
      hotkey,
      onHumanInput: () => computer.noteHumanInput(),
      onStopHotkey: () => stop(HOTKEY_STOP_REASON),
      log
    })
  } catch (error) {
    x11Problem = `cannot open the X display: ${(error as Error).message}`
  }
  let tray: Tray | undefined
  let trayProblem: string | undefined
  // Nobody sits at a virtual display (Xvfb, the container form), so it gets no tray.
  if (!options.headless)
    try {
      tray = await (options.startTray ?? Tray.start)({
        onStop: () => stop(TRAY_STOP_REASON),
        onResume: () => {
          if (!trayState(computer, undefined).canResume) return
          computer.resume()
          log('resumed from the tray')
        },
        ...(hotkey ? { hotkeyLabel: hotkey.label } : {}),
        log
      })
    } catch (error) {
      trayProblem = `cannot reach the session bus: ${(error as Error).message}`
    }
  const keyboardProblem = (): string | undefined => x11Problem ?? x11?.keyboardProblem
  const hotkeyProblem = (): string | undefined => hotkeyInvalid ?? x11Problem ?? x11?.hotkeyProblem
  const controls: LocalControls = {
    keyboard: () => keyboardProblem() === undefined,
    checks() {
      const keyboard = keyboardProblem()
      const hotkeyIssue = hotkeyProblem()
      const trayIssue = trayProblem ?? tray?.problem
      return [
        keyboard
          ? {
              name: 'keyboard activity',
              status: 'warn',
              detail: `${keyboard}: only pointer movement pauses agents`,
              fix: 'run the daemon in an Xorg session whose server has XInput 2.1 or newer'
            }
          : { name: 'keyboard activity', status: 'ok', detail: 'typing or clicking here pauses agent input' },
        !options.stopHotkey
          ? { name: 'stop hotkey', status: 'info', detail: 'disabled in config ("stopHotkey": "")' }
          : hotkeyIssue
            ? {
                name: 'stop hotkey',
                status: 'warn',
                detail: `${options.stopHotkey}: ${hotkeyIssue}`,
                fix: 'set "stopHotkey" in the config to a free combination, such as Ctrl+Alt+Shift+F12'
              }
            : { name: 'stop hotkey', status: 'ok', detail: `${options.stopHotkey} stops all agent input` },
        options.headless
          ? { name: 'tray', status: 'info', detail: 'virtual display: no one is there to see a tray' }
          : trayIssue
            ? {
                name: 'tray',
                status: 'warn',
                detail: `${trayIssue}: no local indicator; stop agents with ${hotkey?.label ?? 'agentconnect-computer pause'}`,
                fix: 'add a status tray (Status Notifier) to the panel, such as the Xfce "Status Tray" plugin'
              }
            : { name: 'tray', status: 'ok', detail: 'the tray icon shows agent control and can stop it' }
      ]
    },
    update() {
      tray?.update(trayState(computer, options.refusal()))
    },
    close() {
      clearInterval(refresh)
      x11?.close()
      tray?.close()
    }
  }
  controls.update()
  // Authority comes and goes without a status change, so the indicator also re-reads it on a timer.
  const refresh = setInterval(() => controls.update(), TRAY_REFRESH_MS)
  refresh.unref()
  const problems = controls.checks().filter((check) => check.status === 'warn')
  for (const check of problems) log(`local controls: ${check.name}: ${check.detail}`)
  return controls
}
