// The browser tier's launch state: the daemon writes it, the launcher reads it on every start (computer-use.md §3.10, §5.8).
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Where Chrome writes `<port>\n/devtools/browser/<uuid>` once its endpoint listens. */
export const PORT_FILE = 'DevToolsActivePort'
const STATE_FILE = 'devtools.json'
// How long a launch waits for the running daemon's state; the image's entrypoint removes the last container's.
export const STATE_WAIT_MS = 15_000

/** What the next browser start passes; absent reads as the tier off. */
export interface DevtoolsLaunch {
  // `--remote-debugging-port=0`, for Google Chrome only.
  tier: boolean
  // `--disable-blink-features=AutomationControlled` beside the switch (§17-26).
  hideWebdriver: boolean
  // The daemon's own egress forwarder, where no AGENTCONNECT_EGRESS_PORT names a managed pod's (§15.4).
  egressPort?: number
}

export const devtoolsStatePath = (dataDir: string): string => join(dataDir, 'browser', STATE_FILE)

export function writeDevtoolsState(dataDir: string, state: DevtoolsLaunch): void {
  const path = devtoolsStatePath(dataDir)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

/** The state file, read tolerantly: anything but `tier: true` is off, and anything but `hideWebdriver: false` hides. */
export function readDevtoolsState(dataDir: string): DevtoolsLaunch | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(devtoolsStatePath(dataDir), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const state = raw as Record<string, unknown>
  const port = state.egressPort
  return {
    tier: state.tier === true,
    hideWebdriver: state.hideWebdriver !== false,
    ...(typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65_536 ? { egressPort: port } : {})
  }
}

/** Waits briefly for the state of a daemon that is still starting; none in time reads as off. */
export async function awaitDevtoolsState(
  dataDir: string,
  waitMs = STATE_WAIT_MS,
  stepMs = 250
): Promise<DevtoolsLaunch | undefined> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const state = readDevtoolsState(dataDir)
    if (state || Date.now() >= deadline) return state
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

// Where Google's package installs Chrome: the image moves /opt/google to /usr/lib/google and links it back (§3.8).
export const GOOGLE_CHROME_DIRS = ['/usr/lib/google/chrome', '/opt/google/chrome']

/** Google Chrome, the only browser the tier opens an endpoint in (§3.8): the path must resolve to Google's binary or launcher. */
export function isGoogleChrome(path: string, dirs: readonly string[] = GOOGLE_CHROME_DIRS): boolean {
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return false
  }
  const roots = dirs.flatMap((dir) => {
    try {
      return [dir, realpathSync(dir)]
    } catch {
      return [dir]
    }
  })
  const dir = dirname(real)
  if (!roots.includes(dir)) return false
  if (basename(real) === 'chrome') return true
  // Google's `google-chrome` script, which ends by exec-ing the `chrome` beside it.
  if (!/^google-chrome(-stable)?$/.test(basename(real))) return false
  try {
    const script = readFileSync(real, 'utf8')
    return script.startsWith('#!') && /^exec -a "\$0" "\$HERE\/chrome" "\$@"$/m.test(script)
  } catch {
    return false
  }
}

// Switches a caller may not pass: the endpoint, its origins, the proxy and the webdriver mark are the launcher's alone.
const LAUNCHER_ONLY = /^--(remote-debugging-|remote-allow-origins|proxy-|no-proxy-server(=|$)|disable-blink-features)/

/** Chrome's switches as `--name[=value]`: on POSIX it takes `-name` too, and nothing after a bare `--` is a switch. */
export function switches(args: readonly string[]): string[] {
  const end = args.indexOf('--')
  return (end === -1 ? args : args.slice(0, end))
    .filter((arg) => /^--?[^-]/.test(arg))
    .map((arg) => arg.replace(/^--?/, '--'))
}

/** The caller's arguments without the launcher's own switches, which Chrome would take as the last value; and those dropped. */
export function callerArgs(args: readonly string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = []
  const dropped: string[] = []
  const end = args.indexOf('--')
  args.forEach((arg, index) => {
    const named = (end === -1 || index < end) && /^--?[^-]/.test(arg) ? arg.replace(/^--?/, '--') : undefined
    ;(named !== undefined && LAUNCHER_ONLY.test(named) ? dropped : kept).push(arg)
  })
  return { kept, dropped }
}

/** The switch, the AutomationControlled flag unless turned off, and the daemon's own forwarder; never `--remote-allow-origins`. */
export function devtoolsFlags(
  launch: DevtoolsLaunch | undefined,
  chrome: boolean,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (!launch) return []
  const flags: string[] = []
  if (launch.tier && chrome) {
    flags.push('--remote-debugging-port=0')
    if (launch.hideWebdriver) flags.push('--disable-blink-features=AutomationControlled')
  }
  // As a managed pod's, without its WebRTC policy: loopback goes through it, the form-fill endpoint alone goes direct.
  if (launch.egressPort !== undefined && !env.AGENTCONNECT_EGRESS_PORT)
    flags.push(
      `--proxy-server=http://127.0.0.1:${launch.egressPort}`,
      `--proxy-bypass-list=<-loopback>;127.0.0.1:${env.FORM_FILL_PORT || '7682'}`
    )
  return flags
}

/** Before a start: the old port file goes, and with the tier off so does the `chrome://inspect` checkbox's saved setting. */
export function prepareProfile(profile: string, tier: boolean): void {
  rmSync(join(profile, PORT_FILE), { force: true })
  if (!tier) clearRemoteDebugging(join(profile, 'Local State'))
}

/** Removes `devtools.remote_debugging` from a `Local State` file, keeping everything else; true when it was there. */
export function clearRemoteDebugging(path: string): boolean {
  let state: unknown
  try {
    state = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
  const devtools = (state as { devtools?: unknown } | null)?.devtools
  if (typeof devtools !== 'object' || devtools === null || !('remote_debugging' in devtools)) return false
  delete (devtools as Record<string, unknown>).remote_debugging
  const mode = statSync(path).mode & 0o777
  writeFileSync(`${path}.ac-tmp`, JSON.stringify(state), { mode })
  renameSync(`${path}.ac-tmp`, path)
  return true
}
