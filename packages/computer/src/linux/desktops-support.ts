// Whether this machine can give each agent its own desktop, and whether the owner wants it (computer-use.md §3.9).
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { findBrowser } from '../browser/launcher.js'
import type { Check } from '../setup.js'

export interface DesktopSupport {
  supported: boolean
  // Why not, and what to install; set when unsupported.
  reason?: string
  fix?: string
  // The session a desktop runs: full Xfce, or only its window manager where Xfce's session is missing.
  session?: 'xfce' | 'xfwm4'
  // The browser a desktop's fork-merge launcher would start, if any.
  browser?: string
}

export interface ProbeDeps {
  platform?: NodeJS.Platform
  which?: (name: string) => string | undefined
  // Starts Xvfb on a display it picks itself; resolves once it serves one, and stops it again.
  tryXvfb?: (xvfb: string, timeoutMs: number) => Promise<string | undefined>
  browser?: () => string | undefined
}

const PACKAGES = 'xvfb dbus-x11 xfce4'
const XVFB_TIMEOUT_MS = 5000

/** An executable on PATH. */
export function which(name: string, path = process.env.PATH ?? ''): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, name), constants.X_OK)
      return join(dir, name)
    } catch {
      // Not here.
    }
  }
  return undefined
}

// Starts a tiny Xvfb with -displayfd, which picks a free display and writes its number once it accepts clients.
export async function tryXvfb(xvfb: string, timeoutMs: number): Promise<string | undefined> {
  const child = spawn(xvfb, ['-displayfd', '3', '-screen', '0', '64x64x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-400)))
  try {
    return await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(`Xvfb did not start within ${timeoutMs / 1000}s`), timeoutMs)
      ;(child.stdio[3] as NodeJS.ReadableStream).on('data', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve(error.message)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve(`Xvfb exited (${code}): ${stderr.trim().split('\n').pop() ?? ''}`)
      })
    })
  } finally {
    child.kill('SIGTERM')
  }
}

/** Probes for what a per-agent desktop needs, starting a real Xvfb rather than only looking for its binary. */
export async function probeDesktopSupport(deps: ProbeDeps = {}): Promise<DesktopSupport> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'linux') return { supported: false, reason: 'per-agent desktops are Linux only' }
  const find = deps.which ?? ((name: string) => which(name))
  const browser = (deps.browser ?? (() => findBrowser()))()
  const withBrowser = browser ? { browser } : {}
  const missing = (what: string): DesktopSupport => ({
    supported: false,
    reason: `${what} is not installed`,
    fix: `install ${PACKAGES}`,
    ...withBrowser
  })
  const xvfb = find('Xvfb')
  if (!xvfb) return missing('Xvfb')
  if (!find('dbus-launch')) return missing('dbus-launch')
  const session = find('xfce4-session') ? 'xfce' : find('xfwm4') ? 'xfwm4' : undefined
  if (!session) return missing('Xfce')
  const failure = await (deps.tryXvfb ?? tryXvfb)(xvfb, XVFB_TIMEOUT_MS)
  if (failure)
    return { supported: false, reason: failure, fix: 'check that Xvfb can start as this user', ...withBrowser }
  return { supported: true, session, ...withBrowser }
}

/** On when the owner left the switch on and this machine supports it. */
export function desktopsEnabled(switchedOn: boolean, support: DesktopSupport): boolean {
  return switchedOn && support.supported
}

export function describeDesktops(switchedOn: boolean, support: DesktopSupport): string {
  if (!support.supported) return `unavailable (${support.reason}): agents take turns on this desktop`
  if (!switchedOn) return 'off (switched off): agents take turns on this desktop'
  return `on: each agent gets its own desktop (Xvfb + ${support.session === 'xfce' ? 'Xfce' : 'xfwm4'})`
}

/** What setup tells the owner while per-agent desktops are on: agents leave this screen and work with a copy of its logins. */
export function desktopsNotice(command: string): string {
  return [
    'Per-agent desktops are on: each agent works on a desktop of its own, not on this screen; watch it in the console',
    "or the viewer. Agents' browsers start with a copy of this desktop's Chromium logins (the console policy",
    `"Share browser logins" turns that off). Turn per-agent desktops off with the tray's "Separate desktop for each`,
    `agent" or: ${command} desktops off`
  ].join('\n')
}

/** The doctor's line for the switch and what this machine supports; `install` is this distribution's install line. */
export function desktopsCheck(switchedOn: boolean, support: DesktopSupport, command: string, install?: string): Check {
  const detail = describeDesktops(switchedOn, support)
  const browserNote = support.browser ? '' : '; no Chromium found, so agents get no shared browser logins'
  if (!support.supported) {
    const fix =
      install && /is not installed$/.test(support.reason ?? '') ? `run: ${command} setup, or: ${install}` : support.fix
    return { name: 'desktops', status: switchedOn ? 'warn' : 'info', detail, ...(fix ? { fix } : {}) }
  }
  if (!switchedOn) return { name: 'desktops', status: 'info', detail, fix: `turn on: ${command} desktops on` }
  return { name: 'desktops', status: support.browser ? 'ok' : 'warn', detail: detail + browserNote }
}
