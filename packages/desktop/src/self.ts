import { execFile } from 'node:child_process'
import { isSea } from 'node:sea'

// Runs this CLI again as a child; children of the daemon share its macOS permission identity.
export function runSelf(args: string[], timeoutMs: number): Promise<string> {
  const argv = isSea() ? args : [process.argv[1]!, ...args]
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

// The executable is the main binary of a macOS .app bundle (the signed AgentConnect Desktop.app).
export const appBundlePath = (): string | undefined => /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(process.execPath)?.[1]

// How the user runs this CLI: `agentconnect desktop` sets AGENTCONNECT_DESKTOP_COMMAND; the standalone bin is the fallback.
export const selfCommand = (): string => process.env.AGENTCONNECT_DESKTOP_COMMAND?.trim() || 'agentconnect-desktop'
