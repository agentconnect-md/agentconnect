import { execFile } from 'node:child_process'
import { resolve } from 'node:path'

// Runs this CLI again as a child; children of the daemon share its macOS permission identity.
export function runSelf(args: string[], timeoutMs: number): Promise<string> {
  const argv = [process.argv[1]!, ...args]
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      argv,
      { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true },
      (error, stdout) =>
        // doctor exits 1 when a check fails but still prints its JSON.
        stdout.trim() ? resolve(stdout) : reject(error ?? new Error('no output'))
    )
  })
}

// The executable is the Node runtime inside the signed AgentConnect Computer.app, which holds the macOS grants.
export const appBundlePath = (): string | undefined => /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(process.execPath)?.[1]

// How the user runs this CLI: `agentconnect computer` sets AGENTCONNECT_COMPUTER_COMMAND; the standalone bin is the fallback.
export const selfCommand = (): string => process.env.AGENTCONNECT_COMPUTER_COMMAND?.trim() || 'agentconnect-computer'

// The CLI's version store names the stable `current` entry a service launches, so an upgrade only moves that link.
export const SERVICE_ENTRY_ENV = 'AGENTCONNECT_COMPUTER_SERVICE_ENTRY'
export const managedEntry = (): string | undefined => process.env[SERVICE_ENTRY_ENV]?.trim() || undefined
// The script a service or autostart entry runs: the managed entry, else this very bundle.
export const serviceEntry = (): string => managedEntry() ?? resolve(process.argv[1]!)
