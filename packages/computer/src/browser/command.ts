// The `browser` and `browser-close` commands: what a desktop's browser wrappers and the daemon run (computer-use.md §3.10).
import { closeBrowser } from './close.js'
import { findBrowser, launchBrowser } from './launcher.js'

export interface BrowserCommandValues {
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
  log: (line: string) => void
): Promise<void> {
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
