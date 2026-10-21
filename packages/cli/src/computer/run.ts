import { spawn } from 'node:child_process'
import { exitAsChild, type ChildResult } from '../delegate.js'
import { DESKTOP_COMMAND_ENV, DESKTOP_SERVICE_ENTRY_ENV, type DesktopLaunch } from './launch.js'

export interface EntryResult {
  code: number
  stdout: string
}

/** Runs one computer daemon command to completion; `capture` collects stdout instead of sharing the terminal. */
export type EntryRunner = (
  launch: DesktopLaunch,
  opts?: { capture?: boolean; timeoutMs?: number }
) => Promise<EntryResult>

// The daemon names this CLI's command in help and fix hints, and installs its service on the store's stable entry.
export function childEnv(launch: DesktopLaunch, selfCommand: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [DESKTOP_COMMAND_ENV]: selfCommand }
  if (launch.serviceEntry) env[DESKTOP_SERVICE_ENTRY_ENV] = launch.serviceEntry
  else delete env[DESKTOP_SERVICE_ENTRY_ENV]
  return env
}

export function entryRunner(selfCommand: string): EntryRunner {
  return (launch, opts = {}) =>
    new Promise((resolve) => {
      const child = spawn(launch.command, launch.args, {
        stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: childEnv(launch, selfCommand),
        windowsHide: true,
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const } : {})
      })
      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      child.on('error', (err) => resolve({ code: 1, stdout: `${stdout}${err.message}` }))
      child.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout }))
    })
}

// Runs the daemon with inherited stdio and exits as it did; SIGTERM is forwarded, terminal SIGINT already reaches it.
export async function execComputer(launch: DesktopLaunch, selfCommand: string): Promise<never> {
  const child = spawn(launch.command, launch.args, { stdio: 'inherit', env: childEnv(launch, selfCommand) })
  const done = new Promise<ChildResult>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
    child.on('error', (err) => {
      console.error(`${selfCommand}: failed to launch ${launch.command}: ${err.message}`)
      resolve({ code: 1, signal: null })
    })
  })
  const onTerm = (): void => void child.kill('SIGTERM')
  const onInt = (): void => {}
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)
  const result = await done
  return exitAsChild(result, () => {
    process.removeListener('SIGTERM', onTerm)
    process.removeListener('SIGINT', onInt)
  })
}
