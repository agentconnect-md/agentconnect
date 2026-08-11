import { spawn, type ChildProcess } from 'node:child_process'
import { AcpStreamPayloadSchema, type AcpOpen } from './acp-stream.js'
import type { ShimEvent } from './protocol.js'

/** How the runner reports back: many events per opened stream, not one response. */
export type EmitEvent = (event: ShimEvent['event']) => void

/** Resolve an executable in THIS filesystem — the sandbox's, which is the whole point. */
export type ResolveCommand = (command: string, env: Record<string, string>) => string | undefined

/** Pod-env names the runtime image accepts, mapped onto the matching runtime's own provider
 *  variables. Interim until the managed egress proxy lands: the key stays deployment-owned
 *  (SandboxTemplate env) instead of traveling from the daemon, and only the runtime whose
 *  vendor the variable names ever sees it. */
export const SANDBOX_PROVIDER_ENV: Readonly<Record<'claude' | 'codex', Readonly<Record<string, string>>>> = {
  claude: { AC_CLAUDE_BASE_URL: 'ANTHROPIC_BASE_URL', AC_CLAUDE_API_KEY: 'ANTHROPIC_API_KEY' },
  codex: { AC_CODEX_BASE_URL: 'OPENAI_BASE_URL', AC_CODEX_API_KEY: 'OPENAI_API_KEY' }
}

/** Provider env for the REQUESTED command (its registry identity, not the resolved path). */
export function sandboxProviderEnv(
  command: string,
  podEnv: Record<string, string | undefined>
): Record<string, string> {
  const base = command.split(/[\\/]/).pop() ?? ''
  const profile = /^claude(?:$|[-.@])/i.test(base) ? 'claude' : /^codex(?:$|[-.@])/i.test(base) ? 'codex' : undefined
  if (!profile) return {}
  const env: Record<string, string> = {}
  for (const [source, target] of Object.entries(SANDBOX_PROVIDER_ENV[profile])) {
    const value = podEnv[source]?.trim()
    if (value) env[target] = value
  }
  return env
}

/**
 * Runs the ACP runtime inside the sandbox and relays its stdio.
 *
 * The relay is deliberately dumb: bytes out as chunk events, bytes in written to stdin,
 * exit reported once. ACP is a complete protocol already, so parsing it here would only add
 * a second place for it to go wrong — and the daemon's `AcpHost` is the half that speaks it.
 */
export class AcpRunner {
  private child?: ChildProcess
  private exited = false

  constructor(
    private readonly deps: {
      emit: EmitEvent
      resolveCommand?: ResolveCommand
      /** Pod environment consulted for SANDBOX_PROVIDER_ENV fill-ins; absent means none. */
      podEnv?: Record<string, string | undefined>
      log?: { info: (m: string) => void; warn: (m: string) => void }
    }
  ) {}

  /** Handle one payload on the ACP stream. Returns once the payload is applied. */
  async apply(rawPayload: unknown): Promise<void> {
    const payload = AcpStreamPayloadSchema.parse(rawPayload)
    if (payload.op === 'open') return this.open(payload)
    if (payload.op === 'chunk') {
      const child = this.child
      if (!child?.stdin) throw new Error('acp stream is not open')
      // Report the write's completion so the daemon side can apply backpressure rather than
      // queueing unboundedly into a runtime that is not draining.
      await new Promise<void>((resolve, reject) => {
        child.stdin!.write(Buffer.from(payload.data, 'base64'), (err) => (err ? reject(err) : resolve()))
      })
      return
    }
    await this.close(payload.deadlineMs ?? 5_000)
  }

  private async open(payload: AcpOpen): Promise<void> {
    if (this.child) throw new Error('acp stream is already open')
    const env = { ...payload.env }
    for (const hint of payload.hints ?? []) {
      if (env[hint.envVar]) continue
      const resolved = this.deps.resolveCommand?.(hint.command, env)
      if (resolved) env[hint.envVar] = resolved
    }
    // Fill-in only, like hints: an env the daemon decided (per-agent key/gateway) stays authoritative.
    for (const [name, value] of Object.entries(sandboxProviderEnv(payload.command, this.deps.podEnv ?? {}))) {
      if (!env[name]) env[name] = value
    }
    const command = this.deps.resolveCommand?.(payload.command, env) ?? payload.command
    const child = spawn(command, payload.args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
      ...(payload.cwd ? { cwd: payload.cwd } : {}),
      detached: process.platform !== 'win32'
    })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) =>
      this.deps.emit({ kind: 'chunk', data: Buffer.from(chunk).toString('base64') })
    )
    child.once('error', (err) => this.finish(null, null, err.message))
    child.once('exit', (code, signal) => this.finish(code, signal))
    if (!child.stdin || !child.stdout) throw new Error('acp runtime stdio is not piped')
  }

  private finish(code: number | null, signal: NodeJS.Signals | number | null, error?: string): void {
    if (this.exited) return
    this.exited = true
    // Sweep the group now, while the pgid is provably still ours: an adapter orphaned by a
    // wrapper's death would otherwise survive the pod's idea of "runtime stopped".
    const child = this.child
    if (child?.pid && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* group already empty */
      }
    }
    this.deps.emit({
      kind: 'exit',
      code: typeof code === 'number' ? code : null,
      signal: typeof signal === 'string' ? signal : null,
      ...(error ? { error } : {})
    })
  }

  /** Graceful stop, escalating past the deadline — the same shape as the local driver. */
  async close(deadlineMs: number): Promise<void> {
    const child = this.child
    this.child = undefined
    if (!child) return
    if (child.exitCode !== null || child.signalCode !== null) return
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          /* group gone — fall back to the child */
        }
      }
      child.kill(signal)
    }
    try {
      child.stdin?.end()
    } catch {
      /* stream already gone */
    }
    kill('SIGTERM')
    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.deps.log?.warn(`acp runtime ignored SIGTERM after ${deadlineMs}ms — sending SIGKILL`)
        kill('SIGKILL')
        setTimeout(done, 2_000)
      }, deadlineMs)
      child.once('exit', done)
    })
  }
}
