import { spawn, type ChildProcess } from 'node:child_process'
import { win32 } from 'node:path'

/** The seams a test replaces to drive the Windows branch from any platform. */
export interface ProcessTreeHost {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  spawn: typeof spawn
}

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

const signalChild = (child: ChildProcess, signal: NodeJS.Signals): void => {
  try {
    child.kill(signal)
  } catch {
    /* already exited */
  }
}

// A Windows signal ends one pid, so a launcher's own child (PyInstaller onefile, an npm wrapper) would outlive it.
function taskkillTree(child: ChildProcess, pid: number, signal: NodeJS.Signals, host: ProcessTreeHost): void {
  const fallback = (): void => {
    if (!hasExited(child)) signalChild(child, signal)
  }
  // Absolute path: the tree walk must not depend on a PATH the daemon did not choose.
  const taskkill = win32.join(host.env.SystemRoot ?? host.env.windir ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  try {
    const killer = host.spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.once('error', fallback)
    killer.once('exit', (code) => {
      if (code !== 0) fallback()
    })
  } catch {
    fallback()
  }
}

/** Signal a child and its descendants: the process group of a detached child on POSIX, `taskkill /T` on Windows. */
export function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  host: ProcessTreeHost = { platform: process.platform, env: process.env, spawn }
): void {
  const pid = child.pid
  // No pid means the command never became a process, and an exited one may have had its pid recycled.
  if (pid === undefined || hasExited(child)) return
  if (host.platform === 'win32') return taskkillTree(child, pid, signal, host)
  try {
    process.kill(-pid, signal)
    return
  } catch {
    /* group already gone — the direct child is what is left */
  }
  signalChild(child, signal)
}
