import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { systemClock, type Clock } from '@agentconnect.md/connection'
import { parseVmmEvent, type VmmExitReason } from './events.js'

/** A host directory exposed to the guest over virtiofs, mounted at `/mnt/<tag>`. */
export interface VmmShare {
  tag: string
  path: string
  readOnly?: boolean
}

export interface VmmLaunch {
  /** Prepared per-VM bundle: kernel, initrd, manifest, and a DISPOSABLE rootfs clone. */
  bundlePath: string
  /** Persistent per-agent disk carrying the workspace and the container image store. */
  dataDiskPath: string
  consoleLogPath: string
  cpuCount: number
  memoryBytes: number
  /** Guest vsock port the shim listens on. The host port is the kernel's to choose. */
  shimPort: number
  shares?: VmmShare[]
}

export interface VmmExit {
  code: number
  /** Absent when the helper died without reporting, which is itself the diagnosis. */
  reason?: VmmExitReason
}

export interface RunningVmm {
  /** Loopback port that reaches the guest's shim, as actually bound. */
  hostPort: number
  pid: number | undefined
  exited: Promise<VmmExit>
  /** Graceful guest shutdown escalating past the deadline. Safe to call on a dead helper. */
  stop(deadlineMs: number): Promise<void>
}

export interface VmmProcessDeps {
  /** Path to the signed `agentconnect-vmm` binary. */
  binary: string
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
  clock?: Clock
  spawn?: typeof nodeSpawn
  /** How long to wait for `booting`. A guest reaches userspace in ~2s, so this is generous. */
  readyTimeoutMs?: number
}

const DEFAULT_READY_TIMEOUT_MS = 30_000

export function vmmArgs(launch: VmmLaunch): string[] {
  return [
    'run',
    launch.bundlePath,
    '--cpus',
    String(launch.cpuCount),
    '--memory',
    String(launch.memoryBytes),
    '--data-disk',
    launch.dataDiskPath,
    '--console-log',
    launch.consoleLogPath,
    // The kernel picks the host port: many VMs cannot share one fixed loopback port.
    '--forward',
    `0:${launch.shimPort}`,
    ...(launch.shares ?? []).flatMap((share) => [
      '--share',
      `${share.tag}=${share.path}${share.readOnly ? ':ro' : ''}`
    ]),
    '--json'
  ]
}

/**
 * Boots one guest and supervises the helper that owns it.
 *
 * Resolves on the helper's `booting` event rather than on spawn, because that event is what
 * carries the loopback port the kernel chose. It is deliberately not a readiness signal: the guest
 * is still coming up, and readiness is the caller's own successful shim bind.
 */
export async function launchVmm(launch: VmmLaunch, deps: VmmProcessDeps): Promise<RunningVmm> {
  const clock = deps.clock ?? systemClock
  const spawn = deps.spawn ?? nodeSpawn
  // Own process group so stop() reaches the helper and the guest it owns in one signal.
  const child = spawn(deps.binary, vmmArgs(launch), {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })

  let reported: VmmExitReason | undefined
  const exited = new Promise<VmmExit>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), ...(reported ? { reason: reported } : {}) })
    })
  })

  // Human warnings, not the event stream — kept at debug so a boot does not spam the daemon log.
  if (child.stderr) {
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) deps.log.debug?.(`vmm: ${line}`)
    })
  }

  const hostPort = await new Promise<number>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clock.clearTimeout(timer)
      fn()
    }
    const timer = clock.setTimeout(() => {
      finish(() => {
        killTree(child, 'SIGKILL')
        reject(new Error(`vmm did not report booting within ${deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms`))
      })
    }, deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)

    if (!child.stdout) {
      finish(() => reject(new Error('vmm: stdout is not piped')))
      return
    }
    createInterface({ input: child.stdout }).on('line', (line) => {
      const event = parseVmmEvent(line)
      if (!event) return
      if (event.event === 'exited') {
        reported = event.reason
        finish(() => reject(new Error(`vmm exited before booting (${event.reason}, code ${event.code})`)))
        return
      }
      const forward = event.forwards.find((f) => f.guestPort === launch.shimPort)
      if (!forward) {
        finish(() => {
          killTree(child, 'SIGKILL')
          reject(new Error(`vmm bound no host port for guest shim port ${launch.shimPort}`))
        })
        return
      }
      deps.log.info(`vmm: guest booting, shim reachable on 127.0.0.1:${forward.hostPort} (vmm ${event.vmmVersion})`)
      finish(() => resolve(forward.hostPort))
    })
    child.once('exit', () => {
      finish(() => reject(new Error('vmm exited before reporting a booting event')))
    })
    child.once('error', (err) => {
      finish(() => reject(new Error(`vmm could not be started: ${err.message}`)))
    })
  })

  return {
    hostPort,
    pid: child.pid,
    exited,
    stop: (deadlineMs) => stopVmm(child, exited, deadlineMs, clock, deps.log)
  }
}

/** SIGTERM is what the helper turns into an ACPI power button press, so the guest shuts down
 *  cleanly and its ext4 stays consistent. SIGKILL is the deadline's last resort and leaves the
 *  data disk dirty, which the next boot has to fsck. */
async function stopVmm(
  child: ChildProcess,
  exited: Promise<VmmExit>,
  deadlineMs: number,
  clock: Clock,
  log: { warn: (m: string) => void }
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  killTree(child, 'SIGTERM')
  const timer = new Promise<'timeout'>((resolve) => {
    const handle = clock.setTimeout(() => resolve('timeout'), deadlineMs)
    void exited.then(() => clock.clearTimeout(handle))
  })
  if ((await Promise.race([exited.then(() => 'done' as const), timer])) === 'timeout') {
    log.warn(`vmm: guest ignored the shutdown request after ${deadlineMs}ms — forcing power off`)
    killTree(child, 'SIGKILL')
    await exited
  }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      /* group already gone — fall through to the direct child */
    }
  }
  try {
    child.kill(signal)
  } catch {
    /* already reaped */
  }
}
