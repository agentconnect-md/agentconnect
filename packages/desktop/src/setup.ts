import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { configPath, controlBaseUrl, isLoopbackHost, type DesktopConfig } from './config.js'
import { CuaDriver } from './driver/client.js'
import { CUA_DRIVER_VERSION } from './driver/install.js'
import { canKeepAwake, displaySleepMinutes, wakeDisplay } from './keep-awake.js'
import { appBundlePath, selfCommand } from './self.js'
import { loadRegistration, registrationPath, type Registration } from './cp/registration.js'
import { ffmpegAvailable, probeCapture } from './stream/ffmpeg.js'
import { screencastTokenPath, waylandSession } from './stream/wayland-capture.js'

export type CheckStatus = 'ok' | 'info' | 'warn' | 'fail'

export interface Check {
  name: string
  status: CheckStatus
  detail: string
  fix?: string
}

// The service has no AGENTCONNECT_DESKTOP_COMMAND, so the CLI renames its default command in checks it relays.
export const localizeChecks = (checks: Check[], command = selfCommand()): Check[] => {
  const rename = (text: string): string => text.replace(/(?<![\w/.-])agentconnect-desktop(?= |$)/g, command)
  return checks.map((check) => ({
    ...check,
    detail: rename(check.detail),
    ...(check.fix === undefined ? {} : { fix: rename(check.fix) })
  }))
}

export interface SetupContext {
  dir: string
  config: DesktopConfig
  driverCommand: string
  ffmpeg: string
  log: (line: string) => void
}

const ICON: Record<CheckStatus, string> = { ok: '✅', info: 'ℹ️ ', warn: '⚠️ ', fail: '❌' }
const FIREWALL_RULE = 'AgentConnect Desktop (Node.js)'
export const MAC_PANES = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
}

export function printChecks(checks: Check[]): boolean {
  const width = Math.max(...checks.map((check) => check.name.length))
  for (const check of checks) {
    console.log(`${ICON[check.status]} ${check.name.padEnd(width)}  ${check.detail}`)
    if (check.fix && check.status !== 'ok') console.log(`   ${' '.repeat(width)}  → ${check.fix}`)
  }
  const failed = checks.filter((check) => check.status === 'fail').length
  const warned = checks.filter((check) => check.status === 'warn').length
  console.log(
    failed
      ? `\n${failed} check(s) failed.`
      : warned
        ? `\nAll required checks passed (${warned} warning(s)).`
        : '\nAll checks passed.'
  )
  return failed === 0
}

// ---- shared probes ----

export const hostApp = (): string => {
  const app = appBundlePath()
  return app ? basename(app) : (process.env.TERM_PROGRAM ?? process.env.__CFBundleIdentifier ?? 'the launching app')
}
// A GUI terminal opened from an SSH session inherits SSH_* variables, but it also names its own app.
export const overSsh = (): boolean =>
  Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY) &&
  !process.env.__CFBundleIdentifier &&
  !process.env.TERM_PROGRAM

interface MacPermissions {
  accessibility: boolean
  screenRecording: boolean
  directCapture: string
}

export async function macPermissions(driver: CuaDriver, prompt = false): Promise<MacPermissions> {
  const result = await driver.call('check_permissions', prompt ? { prompt: true } : { prompt: false })
  const meta = result.structuredContent ?? {}
  return {
    accessibility: meta.accessibility === true,
    screenRecording: meta.screen_recording === true,
    directCapture: typeof meta.direct_capture_status === 'string' ? meta.direct_capture_status : 'not_checked'
  }
}

function powershell(script: string, timeoutMs = 30_000): { ok: boolean; stdout: string } {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs
  })
  return { ok: result.status === 0, stdout: result.stdout ?? '' }
}

const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`

interface FirewallState {
  allow: { name: string; profile: string }[]
  block: { name: string; profile: string }[]
  activeProfiles: string[]
}

// Inbound rules for this node.exe, matched by expanded path because prompt-created rules may differ in case.
function firewallState(program: string): FirewallState | undefined {
  const script = `$ErrorActionPreference = 'SilentlyContinue'
$p = ${psQuote(program)}
$rules = @(Get-NetFirewallApplicationFilter | Where-Object { [Environment]::ExpandEnvironmentVariables($_.Program) -ieq $p } | Get-NetFirewallRule | Where-Object { "$($_.Enabled)" -eq 'True' -and "$($_.Direction)" -eq 'Inbound' } | ForEach-Object { [pscustomobject]@{ name = $_.DisplayName; action = "$($_.Action)"; profile = "$($_.Profile)" } })
$profiles = @(Get-NetConnectionProfile | ForEach-Object { "$($_.NetworkCategory)" })
ConvertTo-Json -Compress -InputObject @{ rules = $rules; profiles = $profiles }`
  const result = powershell(script)
  if (!result.ok) return undefined
  try {
    const parsed = JSON.parse(result.stdout.trim()) as {
      rules: { name: string; action: string; profile: string }[]
      profiles: string[]
    }
    const rules = parsed.rules ?? []
    return {
      allow: rules.filter((rule) => rule.action === 'Allow'),
      block: rules.filter((rule) => rule.action === 'Block'),
      activeProfiles: [...new Set(parsed.profiles ?? [])]
    }
  } catch {
    return undefined
  }
}

// NetworkCategory names (Public/Private/DomainAuthenticated) against rule profiles (Any, or Domain/Private/Public).
export const profileCovered = (profile: string, category: string): boolean =>
  profile === 'Any' || profile.split(/,\s*/).includes(category === 'DomainAuthenticated' ? 'Domain' : category)

// ---- doctor ----

export async function doctor(ctx: SetupContext, captureTimeoutMs = 15_000): Promise<Check[]> {
  const checks: Check[] = []
  const { config } = ctx
  const registration = registrationCheck(ctx.dir)
  checks.push(
    config.clients.length > 0
      ? {
          name: 'config',
          status: 'ok',
          detail: `${configPath(ctx.dir)} (clients: ${config.clients.map((client) => client.name).join(', ')})`
        }
      : registration.status === 'ok'
        ? { name: 'config', status: 'ok', detail: `${configPath(ctx.dir)} (no local client tokens)` }
        : { name: 'config', status: 'fail', detail: 'no client token yet', fix: `run: ${selfCommand()} setup` }
  )
  checks.push(registration)
  checks.push(sessionCheck())
  wakeDisplay()

  if (isAbsolute(ctx.driverCommand) && !existsSync(ctx.driverCommand)) {
    checks.push({
      name: 'cua-driver',
      status: 'fail',
      detail: `missing ${ctx.driverCommand}`,
      fix: `run: ${selfCommand()} setup`
    })
  } else {
    const driver = new CuaDriver({ command: ctx.driverCommand, callTimeoutMs: config.driverCallTimeoutMs })
    try {
      const size = await driver.call('get_screen_size', {})
      checks.push({
        name: 'cua-driver',
        status: 'ok',
        detail: `${driver.version ?? CUA_DRIVER_VERSION}: ${size.content.find((block) => block.text)?.text ?? 'started'}`
      })
      if (process.platform === 'darwin') checks.push(...macPermissionChecks(await macPermissions(driver)))
      const shot = await driver
        .call('get_desktop_state', { max_image_dimension: 320 })
        .then(() => undefined)
        .catch((error: Error) => error.message)
      checks.push(
        shot
          ? { name: 'screenshot', status: 'fail', detail: shot.slice(0, 160), fix: permissionFix() }
          : { name: 'screenshot', status: 'ok', detail: 'desktop capture works' }
      )
    } catch (error) {
      checks.push({
        name: 'cua-driver',
        status: 'fail',
        detail: (error as Error).message.slice(0, 160),
        fix: `run: ${selfCommand()} setup`
      })
    } finally {
      await driver.close()
    }
  }

  checks.push(displayCheck(config))
  checks.push(...ffmpegChecks(ctx, captureTimeoutMs))
  if (process.platform === 'win32') checks.push(firewallCheck(config))
  if (process.platform === 'linux') checks.push(...linuxChecks(ctx))
  checks.push(await daemonCheck(config))
  return checks
}

// Whether this desktop is registered with a Control Plane as a Computer (computer-use.md §3.6).
function registrationCheck(dir: string): Check {
  let registration: Registration | undefined
  try {
    registration = loadRegistration(dir)
  } catch (error) {
    return {
      name: 'control plane',
      status: 'fail',
      detail: `unreadable ${registrationPath(dir)}: ${(error as Error).message}`.slice(0, 300),
      fix: `register again: ${selfCommand()} setup --register <token> --cp-url <url>`
    }
  }
  if (!registration) {
    return { name: 'control plane', status: 'info', detail: 'not registered: local client tokens only' }
  }
  if (registration.revokedAt) {
    return {
      name: 'control plane',
      status: 'fail',
      detail: `computer ${registration.computerId} was revoked (${registration.revokedReason ?? 'by the Control Plane'}): all input is refused`,
      fix: `create a new registration in the console, then: ${selfCommand()} setup --register <token> --cp-url ${registration.cpUrl}`
    }
  }
  return {
    name: 'control plane',
    status: 'ok',
    detail: `registered as computer ${registration.computerId} with ${registration.cpUrl}`
  }
}

function sessionCheck(): Check {
  if (process.platform === 'darwin') {
    return overSsh()
      ? {
          name: 'session',
          status: 'warn',
          detail: 'running over SSH: macOS ties permissions to the app that starts the daemon',
          fix: 'run setup / run from Terminal on the desktop itself'
        }
      : { name: 'session', status: 'ok', detail: `desktop session, host app ${hostApp()}` }
  }
  if (process.platform === 'win32') {
    const session = process.env.SESSIONNAME
    if (!session) {
      return {
        name: 'session',
        status: 'fail',
        detail: 'not an interactive desktop session (service or scheduled task?)',
        fix: 'start it from a terminal on the logged-in desktop'
      }
    }
    return session.startsWith('RDP')
      ? {
          name: 'session',
          status: 'warn',
          detail: `${session}: disconnecting RDP locks this session and stops capture`,
          fix: 'prefer the console session'
        }
      : { name: 'session', status: 'ok', detail: `interactive session (${session})` }
  }
  if (waylandSession()) {
    return {
      name: 'session',
      status: 'ok',
      detail: `Wayland (${process.env.XDG_CURRENT_DESKTOP ?? 'unknown desktop'}, ${process.env.WAYLAND_DISPLAY})`
    }
  }
  return process.env.DISPLAY
    ? { name: 'session', status: 'ok', detail: `X11 display ${process.env.DISPLAY}` }
    : {
        name: 'session',
        status: 'fail',
        detail: 'no DISPLAY or WAYLAND_DISPLAY',
        fix: 'run inside the graphical session (or export its WAYLAND_DISPLAY, XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS)'
      }
}

const permissionFix = (): string | undefined =>
  process.platform === 'darwin' ? `grant ${hostApp()} the macOS permissions: ${selfCommand()} setup` : undefined

function macPermissionChecks(state: MacPermissions): Check[] {
  const app = hostApp()
  const reopen = appBundlePath() ? `then: ${selfCommand()} service restart` : 'then Cmd+Q and reopen'
  return [
    state.accessibility
      ? { name: 'accessibility', status: 'ok', detail: `granted to ${app}` }
      : {
          name: 'accessibility',
          status: 'fail',
          detail: `not granted to ${app}: clicks and keys are silently dropped`,
          fix: `Privacy & Security > Accessibility (macOS 27: Device Control and Data Access): switch it on, ${reopen}`
        },
    state.screenRecording
      ? { name: 'screen recording', status: 'ok', detail: `granted to ${app}` }
      : {
          name: 'screen recording',
          status: 'fail',
          detail: `not granted to ${app}`,
          fix: `Privacy & Security > Screen & System Audio Recording: switch it on, ${reopen}`
        }
  ]
}

function displayCheck(config: DesktopConfig): Check {
  const minutes = displaySleepMinutes()
  const setting =
    minutes === undefined ? '' : minutes === 0 ? ' (display sleep: never)' : ` (display sleep: ${minutes} min)`
  if (config.keepAwake && !canKeepAwake()) {
    return {
      name: 'display',
      status: 'warn',
      detail: 'cannot hold this desktop awake: a blanked or locked screen cannot be captured or controlled',
      fix: 'disable screen blanking and automatic lock in the desktop settings'
    }
  }
  return config.keepAwake
    ? { name: 'display', status: 'ok', detail: `the daemon keeps the display awake while it runs${setting}` }
    : {
        name: 'display',
        status: minutes === 0 ? 'ok' : 'warn',
        detail: `keepAwake is off${setting}: a sleeping or locked display cannot be captured or controlled`,
        fix: 'set "keepAwake": true in config.json'
      }
}

const GNOME_HELPER = 'winrects@cua'
const gnomeWayland = (): boolean => waylandSession() && /GNOME/i.test(process.env.XDG_CURRENT_DESKTOP ?? '')

function gnomeHelperState(): 'active' | 'installed' | 'missing' {
  const info = spawnSync('gnome-extensions', ['info', GNOME_HELPER], { encoding: 'utf8' })
  if (info.status !== 0) return 'missing'
  return /State:\s*(ACTIVE|ENABLED)/i.test(info.stdout ?? '') ? 'active' : 'installed'
}

function linuxChecks(ctx: SetupContext): Check[] {
  if (!waylandSession()) return []
  const checks: Check[] = []
  if (gnomeWayland()) {
    const helper = gnomeHelperState()
    checks.push(
      helper === 'active'
        ? {
            name: 'gnome helper',
            status: 'ok',
            detail: `${GNOME_HELPER} extension active (pixel geometry, capture, cursor)`
          }
        : {
            name: 'gnome helper',
            status: 'fail',
            detail:
              helper === 'installed'
                ? `${GNOME_HELPER} is installed but not loaded yet`
                : `${GNOME_HELPER} extension missing: no pixel coordinates or safe input on GNOME Wayland`,
            fix: helper === 'installed' ? 'log out and back in once' : `run: ${selfCommand()} setup`
          }
    )
  }
  const portal = spawnSync('systemctl', ['--user', 'is-active', 'xdg-desktop-portal'], { encoding: 'utf8' })
  checks.push(
    portal.stdout?.trim() === 'active'
      ? { name: 'portal', status: 'ok', detail: 'xdg-desktop-portal running (screen sharing, remote input)' }
      : {
          name: 'portal',
          status: 'fail',
          detail: 'xdg-desktop-portal is not running on this session',
          fix: 'install xdg-desktop-portal plus the desktop backend (xdg-desktop-portal-gnome / -kde)'
        }
  )
  if (ctx.config.webrtc) {
    const gi = spawnSync('python3', ['-c', 'import gi'], { stdio: 'ignore' }).status === 0
    const missing = [
      !gi && 'python3-gi',
      ...['pipewiresrc', 'y4menc', 'videorate'].filter(
        (element) => spawnSync('gst-inspect-1.0', [element], { stdio: 'ignore' }).status !== 0
      )
    ].filter(Boolean)
    checks.push(
      missing.length === 0
        ? { name: 'pipewire', status: 'ok', detail: 'python3-gi and GStreamer PipeWire capture available' }
        : {
            name: 'pipewire',
            status: 'warn',
            detail: `missing ${missing.join(', ')}: the /view page falls back to screenshots`,
            fix: 'install python3-gi gstreamer1.0-pipewire gstreamer1.0-plugins-good gstreamer1.0-plugins-base'
          }
    )
  }
  return checks
}

function ffmpegChecks(ctx: SetupContext, timeoutMs: number): Check[] {
  if (!ctx.config.webrtc)
    return [{ name: 'webrtc viewer', status: 'warn', detail: 'disabled in config ("webrtc": false)' }]
  if (!ffmpegAvailable(ctx.ffmpeg)) {
    return [
      {
        name: 'ffmpeg',
        status: 'warn',
        detail: 'not found: the /view page falls back to screenshots',
        fix: `run: ${selfCommand()} install-ffmpeg`
      }
    ]
  }
  // Without a restore token the probe would open GNOME's screen-sharing dialog, which only setup should do.
  if (waylandSession() && !existsSync(screencastTokenPath(ctx.dir))) {
    return [
      { name: 'ffmpeg', status: 'ok', detail: ctx.ffmpeg },
      {
        name: 'screen capture',
        status: 'warn',
        detail: 'screen sharing not approved yet (Wayland portal): /view falls back to screenshots',
        fix: `run: ${selfCommand()} setup, then pick the screen and click Share`
      }
    ]
  }
  const probe = probeCapture(ctx.ffmpeg, ctx.config.streamFps, timeoutMs, ctx.dir)
  return [
    { name: 'ffmpeg', status: 'ok', detail: ctx.ffmpeg },
    probe.ok
      ? { name: 'screen capture', status: 'ok', detail: `ffmpeg ${probe.input} captures the display` }
      : {
          name: 'screen capture',
          status: 'fail',
          detail: probe.error ?? 'ffmpeg could not capture the display',
          fix:
            process.platform === 'darwin'
              ? 'answer the macOS screen-capture prompt (setup triggers it), then Cmd+Q and reopen the terminal'
              : 'check that a desktop is attached and unlocked'
        }
  ]
}

function firewallCheck(config: DesktopConfig): Check {
  if (isLoopbackHost(config.host)) {
    return { name: 'firewall', status: 'info', detail: `listening on ${config.host} only; no inbound rule needed` }
  }
  const state = firewallState(process.execPath)
  if (!state) return { name: 'firewall', status: 'warn', detail: 'could not read Windows Firewall rules' }
  const fix = `run: ${selfCommand()} setup (asks for administrator approval once)`
  if (state.block.length > 0) {
    return {
      name: 'firewall',
      status: 'fail',
      detail: `inbound block rule(s) for ${process.execPath}: ${state.block.map((rule) => rule.name).join(', ')}`,
      fix
    }
  }
  const uncovered = state.activeProfiles.filter(
    (category) => !state.allow.some((rule) => profileCovered(rule.profile, category))
  )
  if (state.allow.length === 0 || uncovered.length > 0) {
    return {
      name: 'firewall',
      status: 'warn',
      detail:
        state.allow.length === 0
          ? 'no inbound allow rule for Node.js: remote MCP and WebRTC will be blocked or prompt'
          : `Node.js is not allowed on active ${uncovered.join('/')} network(s)`,
      fix
    }
  }
  return {
    name: 'firewall',
    status: 'ok',
    detail: `Node.js allowed inbound (${state.allow.map((rule) => rule.profile).join(', ')})`
  }
}

async function daemonCheck(config: DesktopConfig): Promise<Check> {
  const running = await fetch(`${controlBaseUrl(config)}/healthz`, { signal: AbortSignal.timeout(2000) })
    .then((response) => response.ok)
    .catch(() => false)
  return {
    name: 'daemon',
    status: running ? 'ok' : 'info',
    detail: running
      ? `running on port ${config.port}`
      : `not running (start it with: ${selfCommand()} run; listens on ${config.host}:${config.port})`
  }
}

// ---- setup: everything that needs a person's approval, done once at install ----

export async function setupPermissions(ctx: SetupContext): Promise<void> {
  if (process.platform === 'darwin') return setupMac(ctx)
  if (process.platform === 'win32') return setupWindowsFirewall(ctx)
  if (process.platform === 'linux') return setupLinux(ctx)
}

// Wayland: the GNOME helper extension, then the two portal consents (screen sharing, remote input), each asked once.
async function setupLinux(ctx: SetupContext): Promise<void> {
  if (!waylandSession()) {
    ctx.log(
      process.env.DISPLAY ? 'X11 session: no approvals needed.' : 'No graphical session here: nothing to approve.'
    )
    return
  }
  if (gnomeWayland()) {
    const state = gnomeHelperState()
    if (state === 'missing') {
      const installer = join(dirname(ctx.driverCommand), 'wayland-helper', 'install.sh')
      const result = spawnSync(installer, [], { encoding: 'utf8' })
      ctx.log(
        result.status === 0
          ? `Installed the ${GNOME_HELPER} GNOME extension.`
          : `Extension install failed: ${result.stderr}`
      )
    }
    if (state !== 'active') ctx.log('GNOME loads extensions at login: log out and back in once, then run setup again.')
  }
  if (ctx.config.webrtc && ffmpegAvailable(ctx.ffmpeg)) {
    ctx.log('Approve screen sharing on this screen: pick the monitor, then click Share (asked once).')
    const probe = probeCapture(ctx.ffmpeg, ctx.config.streamFps, 180_000, ctx.dir)
    ctx.log(
      probe.ok ? 'Screen sharing approved; the WebRTC viewer can stream.' : `Screen sharing failed: ${probe.error}`
    )
  }
  ctx.log('Approve remote input on this screen: allow "remote interaction" when GNOME asks (asked once).')
  const driver = new CuaDriver({ command: ctx.driverCommand, callTimeoutMs: 180_000 })
  try {
    // Pointer moves go through the GNOME helper; only a key press proves the libei/RemoteDesktop route.
    await driver.call('press_key', { scope: 'desktop', key: 'shift' })
    ctx.log('Remote input works.')
  } catch (error) {
    ctx.log(`Remote input not available yet: ${(error as Error).message.slice(0, 200)}`)
  } finally {
    await driver.close()
  }
}

async function setupMac(ctx: SetupContext): Promise<void> {
  if (overSsh()) {
    ctx.log(`macOS permissions cannot be granted over SSH: run \`${selfCommand()} setup\` in Terminal on the Mac.`)
    return
  }
  const app = hostApp()
  // Prompting can wait on dialogs, so this driver gets a generous timeout.
  const driver = new CuaDriver({ command: ctx.driverCommand, callTimeoutMs: 180_000 })
  try {
    let state = await macPermissions(driver)
    if (state.accessibility && state.screenRecording) {
      ctx.log(`macOS permissions already granted to ${app}.`)
    } else {
      ctx.log(`Requesting Accessibility and Screen Recording for ${app}: answer the macOS dialogs.`)
      state = await macPermissions(driver, true).catch(() => state)
      if (!state.accessibility) open(MAC_PANES.accessibility)
      else if (!state.screenRecording) open(MAC_PANES.screenRecording)
      state = await waitForGrants(ctx, app, state)
    }
    if (ctx.config.webrtc && ffmpegAvailable(ctx.ffmpeg) && state.screenRecording) {
      // ffmpeg's own capture raises macOS' separate "bypass the private window picker" consent.
      ctx.log('Testing ffmpeg screen capture: if macOS asks to let the app bypass the window picker, click Allow.')
      const probe = probeCapture(ctx.ffmpeg, ctx.config.streamFps, 120_000, ctx.dir)
      ctx.log(probe.ok ? 'ffmpeg screen capture works.' : `ffmpeg screen capture failed: ${probe.error}`)
    }
    if (!state.screenRecording || !state.accessibility) {
      ctx.log(`After switching the permissions on, quit ${app} (Cmd+Q), reopen it and run: ${selfCommand()} doctor`)
    }
  } finally {
    await driver.close()
  }
}

// Accessibility changes apply live; Screen Recording usually only after the host app restarts.
async function waitForGrants(ctx: SetupContext, app: string, initial: MacPermissions): Promise<MacPermissions> {
  let state = initial
  const interactive = process.stdin.isTTY
  ctx.log(
    `Waiting for: ${[!state.accessibility && 'Accessibility', !state.screenRecording && 'Screen Recording'].filter(Boolean).join(', ')}` +
      (interactive ? ' (press Enter to stop waiting)' : '')
  )
  let skipped = false
  const rl = interactive ? createInterface({ input: process.stdin }) : undefined
  rl?.once('line', () => (skipped = true))
  const deadline = Date.now() + 10 * 60_000
  let openedScreenPane = state.accessibility
  try {
    while (!skipped && Date.now() < deadline && !(state.accessibility && state.screenRecording)) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      // A driver process keeps the grants it saw at launch, so each poll asks a fresh one.
      const probe = new CuaDriver({ command: ctx.driverCommand, callTimeoutMs: 20_000 })
      const next = await macPermissions(probe)
        .catch(() => state)
        .finally(() => probe.close())
      if (next.accessibility && !state.accessibility) ctx.log(`Accessibility granted to ${app}.`)
      if (next.screenRecording && !state.screenRecording) ctx.log(`Screen Recording granted to ${app}.`)
      state = next
      if (state.accessibility && !state.screenRecording && !openedScreenPane) {
        openedScreenPane = true
        open(MAC_PANES.screenRecording)
        ctx.log(`Now switch on Screen & System Audio Recording for ${app}; it takes effect after reopening ${app}.`)
      }
    }
  } finally {
    rl?.close()
  }
  return state
}

export function open(url: string): void {
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
}

function setupWindowsFirewall(ctx: SetupContext): void {
  if (isLoopbackHost(ctx.config.host)) {
    ctx.log(`Listening on ${ctx.config.host} only, so no Windows Firewall rule is needed.`)
    return
  }
  const program = process.execPath
  const state = firewallState(program)
  const uncovered = state?.activeProfiles.filter(
    (category) => !state.allow.some((rule) => profileCovered(rule.profile, category))
  )
  if (state && state.block.length === 0 && state.allow.length > 0 && uncovered?.length === 0) {
    ctx.log('Windows Firewall already allows Node.js inbound.')
    return
  }
  ctx.log(`Adding a Windows Firewall rule "${FIREWALL_RULE}" for ${program} (approve the administrator prompt).`)
  // Block rules (created when someone pressed Cancel on Windows' own prompt) would override the allow rule.
  const elevated = `$p = ${psQuote(program)}
Get-NetFirewallRule -DisplayName ${psQuote(FIREWALL_RULE)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallApplicationFilter | Where-Object { [Environment]::ExpandEnvironmentVariables($_.Program) -ieq $p } | Get-NetFirewallRule | Where-Object { "$($_.Action)" -eq 'Block' -and "$($_.Direction)" -eq 'Inbound' } | Disable-NetFirewallRule
New-NetFirewallRule -DisplayName ${psQuote(FIREWALL_RULE)} -Direction Inbound -Program $p -Action Allow -Profile Any | Out-Null`
  const encoded = Buffer.from(elevated, 'utf16le').toString('base64')
  const result = powershell(
    `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'`,
    180_000
  )
  ctx.log(
    result.ok
      ? 'Firewall rule added; any Node.js block rules were disabled.'
      : 'Firewall rule not added (administrator prompt declined?); Windows will ask on first connection instead.'
  )
}
