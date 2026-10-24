// What the desktop tells the Control Plane about itself: profile, capabilities and doctor results (computer-use.md §2.2, §3.5).
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { release } from 'node:os'
import type {
  ComputerCapabilities,
  ComputerDoctorReport,
  ComputerIsolation,
  ComputerOs,
  ComputerSession
} from '@agentconnect.md/protocol/computer'
import type { Check } from '../setup.js'

const MAX_CHECKS = 64
const MAX_TEXT = 1000

export const computerOs = (platform: NodeJS.Platform = process.platform): ComputerOs =>
  platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'

export function osVersion(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'linux') {
    try {
      const pretty = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1]
      if (pretty) return pretty.slice(0, 120)
    } catch {
      // Fall through to the kernel release.
    }
  }
  if (platform === 'darwin') {
    const result = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' })
    if (result.status === 0 && result.stdout.trim()) return `macOS ${result.stdout.trim()}`
  }
  return `${platform} ${release()}`.slice(0, 120)
}

// Xvfb is a virtual X server whose command line names the display it serves.
function xvfbServes(display: string): boolean {
  const number = /^:(\d+)/.exec(display)?.[1]
  if (number === undefined) return false
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      if (/(^|\/)Xvfb$/.test(argv[0] ?? '') && argv.includes(`:${number}`)) return true
    }
  } catch {
    // An unreadable /proc reads as a real X server.
  }
  return false
}

export function sessionKind(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): ComputerSession {
  if (platform === 'darwin') return 'aqua'
  if (platform === 'win32') return env.SESSIONNAME?.startsWith('RDP') ? 'rdp' : 'console'
  if (env.WAYLAND_DISPLAY) return 'wayland-gnome'
  return env.DISPLAY && xvfbServes(env.DISPLAY) ? 'xvfb' : 'x11'
}

export function isolationKind(env: NodeJS.ProcessEnv = process.env): ComputerIsolation {
  const declared = env.AGENTCONNECT_COMPUTER_ISOLATION
  if (declared === 'none' || declared === 'container' || declared === 'vm') return declared
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv') ? 'container' : 'none'
}

const truncate = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text)

export function doctorReport(checks: Check[], at = new Date()): ComputerDoctorReport {
  return {
    checkedAt: at.toISOString(),
    checks: checks.slice(0, MAX_CHECKS).map((check) => ({
      name: check.name.slice(0, 64) || 'check',
      status: check.status,
      detail: truncate(check.detail),
      ...(check.fix ? { fix: truncate(check.fix) } : {})
    }))
  }
}

export interface DisplayInfo {
  screenWidth: number
  screenHeight: number
  scale: number
}

/** Capabilities read off doctor's checks; an unknown check reads as not available rather than guessed. */
export function capabilitiesFrom(
  checks: Check[] | undefined,
  display: DisplayInfo | undefined,
  options: {
    platform?: NodeJS.Platform
    session?: ComputerSession
    webrtc?: boolean
    keyboardActivity?: boolean
    egress?: boolean
  } = {}
): ComputerCapabilities {
  const platform = options.platform ?? process.platform
  const status = (name: string) => checks?.find((check) => check.name === name)?.status
  const ok = (name: string) => status(name) === 'ok'
  const known = (name: string) => (status(name) === undefined ? undefined : ok(name))
  const driver = ok('cua-driver')
  const accessibility = known('accessibility')
  const screenshot = driver && ok('screenshot')
  const permissions: ComputerCapabilities['permissions'] = {}
  if (accessibility !== undefined) permissions.accessibility = accessibility
  const screenRecording = known('screen recording')
  if (screenRecording !== undefined) permissions.screenRecording = screenRecording
  const portal = known('portal')
  if (portal !== undefined) permissions.portal = portal
  const firewall = status('firewall')
  if (firewall !== undefined) permissions.firewall = firewall === 'ok' || firewall === 'info'
  return {
    screenshot,
    // On macOS clicks are dropped silently without Accessibility, so input needs that grant too.
    input: driver && (platform !== 'darwin' || accessibility === true),
    // libei on GNOME Wayland sends keycodes only, so IME text is dropped (§3.2.3).
    textInput: options.session === 'wayland-gnome' ? 'keymap-only' : 'full',
    humanActivity: options.keyboardActivity ? 'pointer+keyboard' : 'pointer',
    backgroundInput: false,
    accessibilityTree: false,
    viewer: options.webrtc !== false && ok('ffmpeg') && ok('screen capture'),
    viewerStun: true,
    ...(options.egress ? { egress: true } : {}),
    displays:
      display && display.screenWidth > 0 && display.screenHeight > 0
        ? [
            {
              id: 'primary',
              width: Math.round(display.screenWidth),
              height: Math.round(display.screenHeight),
              scale: display.scale > 0 ? display.scale : 1
            }
          ]
        : [],
    permissions
  }
}
