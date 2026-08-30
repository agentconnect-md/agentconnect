/** The shared foreground daemon-run path used by both `agentconnect run` and the
 *  decline branch of `agentconnect login`. Resolves only after the daemon stops
 *  (i.e. after SIGINT/SIGTERM). Deps are injectable so the wiring is testable
 *  without spawning a real daemon or hooking real signals. */
import { Daemon } from '../daemon.js'
import type { FlatOverrides } from '../config/load-config.js'

export interface ForegroundOpts {
  root?: string
  configPath?: string
  agentName?: string
  overrides?: FlatOverrides
  /** Supervisor marker (AGENTCONNECT_SUPERVISOR) forwarded to the Daemon so it
   *  can gate CP-commanded restart/upgrade (cli-daemon-split.md §7.1). */
  supervisor?: string
  /** `--k8s`: runtimes run in cluster sandbox pods, not on this host. */
  k8s?: boolean
  /** `--vm`: runtimes run in per-agent VMs on this host. Experimental, macOS/arm64 only. */
  vm?: boolean
  keyServer?: string
  keyServerTokenPath?: string
}

export interface ForegroundDeps {
  createDaemon: (o: ForegroundOpts) => { start(): Promise<void>; stop(): Promise<void> }
  onSignal: (handler: () => void) => void
  out: NodeJS.WritableStream
  forceExit: (code: number) => void
}

export async function runForeground(opts: ForegroundOpts, deps: Partial<ForegroundDeps> = {}): Promise<void> {
  const createDaemon = deps.createDaemon ?? ((o: ForegroundOpts) => new Daemon(o))
  const onSignal =
    deps.onSignal ??
    ((handler: () => void) => {
      process.on('SIGINT', handler)
      process.on('SIGTERM', handler)
    })
  const out = deps.out ?? process.stdout
  const forceExit = deps.forceExit ?? ((code: number) => process.exit(code))

  const daemon = createDaemon(opts)
  await daemon.start()
  out.write('agentconnect: daemon running (Ctrl-C to stop)\n')

  await new Promise<void>((resolve) => {
    let stopping = false
    onSignal(() => {
      // Second signal while a graceful stop is in flight = the user insisting: exit
      // immediately rather than staying wedged behind whatever stop() is stuck on.
      if (stopping) {
        out.write('agentconnect: forced exit (shutdown was still in progress)\n')
        forceExit(130)
        return
      }
      stopping = true
      void daemon.stop().finally(() => resolve())
    })
  })
}
