// The `browser` and `browser-close` commands: what a desktop's browser wrappers and the daemon run (computer-use.md §3.10).
import { closeBrowser } from './close.js'
import { desktopBrowserPlan } from '../linux/desktops.js'
import { findBrowser, launchBrowser } from './launcher.js'

// A desktop's wrappers run this: X11 on that desktop, and the main session bus whose keyring decrypts the cookies.
async function desktopBrowser(id: string, args: string[], log: (line: string) => void, dataDir: string): Promise<void> {
  const plan = desktopBrowserPlan(dataDir, id)
  const browser = findBrowser(process.env.PATH, plan.skip)
  if (!browser) throw new Error('no Chromium or Google Chrome found on PATH')
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.WAYLAND_DISPLAY
  if (plan.mainBus) env.DBUS_SESSION_BUS_ADDRESS = plan.mainBus
  const result = await launchBrowser({
    profile: plan.profile,
    ...(plan.master ? { master: plan.master } : {}),
    sources: plan.sources,
    browser,
    // The desktop's tabs come back after its browser was closed for idleness (computer-use.md §3.10).
    args: ['--ozone-platform=x11', '--restore-last-session', ...args],
    env,
    log
  })
  log(
    `desktop ${id}: ${result.handedOff ? 'browser already running; the request went to it' : `browser started (pid ${result.pid ?? '?'})`}`
  )
}

export interface BrowserCommandValues {
  // An agent desktop (computer-use.md §3.9): its profile, the master and the other desktops' profiles come from its state.
  desktop?: string
  profile?: string
  master?: string
  source?: string[]
  browser?: string
  display?: string
  'skip-path'?: string[]
}

export async function browserCommand(
  values: BrowserCommandValues,
  args: string[],
  log: (line: string) => void,
  dataDir?: string
): Promise<void> {
  if (values.desktop && dataDir) return desktopBrowser(values.desktop, args, log, dataDir)
  if (!values.profile) {
    throw new Error('usage: browser --profile DIR [--master DIR] [--source DIR]... [--browser PATH] [-- BROWSER_ARGS]')
  }
  const browser = values.browser ?? findBrowser(process.env.PATH, values['skip-path'] ?? [])
  if (!browser) throw new Error('no Chromium or Google Chrome found on PATH')
  const result = await launchBrowser({
    profile: values.profile,
    ...(values.master ? { master: values.master } : {}),
    sources: values.source ?? [],
    browser,
    args,
    log
  })
  log(
    result.handedOff ? 'browser already running; the request went to it' : `browser started (pid ${result.pid ?? '?'})`
  )
}

export async function browserCloseCommand(values: BrowserCommandValues, log: (line: string) => void): Promise<void> {
  const display = values.display ?? process.env.DISPLAY
  if (!values.profile || !display) throw new Error('usage: browser-close --profile DIR [--display :N]')
  log(`browser: ${await closeBrowser({ profile: values.profile, display, log })}`)
}
