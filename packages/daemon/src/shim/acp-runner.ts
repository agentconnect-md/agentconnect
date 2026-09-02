import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  CODEX_DEFAULT_ENDPOINT,
  codexConfigWithBaseUrlFillIn,
  codexConfigWithFloor,
  codexGatewayAuthRequest,
  objectFromJson
} from '../runtimes/codex-config.js'
import { AcpStreamPayloadSchema, type AcpOpen } from './acp-stream.js'
import { seedDshPreset } from './dsh-preset.js'
import { SANDBOX_BROWSER_EXECUTABLE_ENV, SANDBOX_GH_WRAPPER_DIR } from './sandbox-paths.js'
import type { ShimEvent } from './protocol.js'

/** How the runner reports back: many events per opened stream, not one response. */
export type EmitEvent = (event: ShimEvent['event']) => void

/** Resolve an executable in THIS filesystem — the sandbox's, which is the whole point. */
export type ResolveCommand = (command: string, env: Record<string, string>) => string | undefined

/** Pod-env names the runtime image accepts, mapped onto the matching runtime's own provider
 *  variables. Interim until the managed egress proxy lands: the key stays deployment-owned
 *  (SandboxTemplate env) instead of traveling from the daemon, and only the runtime whose
 *  vendor the variable names ever sees it. */
export const SANDBOX_PROVIDER_ENV: Readonly<Record<'claude' | 'codex' | 'deepseek', Readonly<Record<string, string>>>> =
  {
    claude: { AC_CLAUDE_BASE_URL: 'ANTHROPIC_BASE_URL', AC_CLAUDE_API_KEY: 'ANTHROPIC_API_KEY' },
    codex: { AC_CODEX_BASE_URL: 'OPENAI_BASE_URL', AC_CODEX_API_KEY: 'OPENAI_API_KEY' },
    // DeepSeek Harness reads the launching environment ahead of every stored credential layer, so
    // these two are the whole of its configuration in a sandbox that seeds no $DSH_HOME.
    deepseek: { AC_DEEPSEEK_BASE_URL: 'DEEPSEEK_BASE_URL', AC_DEEPSEEK_API_KEY: 'DEEPSEEK_API_KEY' }
  }

/** Filesystem and locale facts only the pod knows. HOME is the load-bearing one: the runtime
 *  writes its state there, and the daemon cannot name a path on a machine it is not on. */
const POD_BASE_ENV = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'] as const

function podBaseEnv(podEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of POD_BASE_ENV) {
    const value = podEnv[name]
    if (value) env[name] = value
  }
  return env
}

/** PATH with the image's gh wrapper first, or unchanged when this image ships none. */
// Decided HERE, not sent by the daemon: the wrapper dir is the IMAGE's layout, and a daemon naming a path on a
// machine it is not on is the class of bug sandbox-paths.ts exists to keep out.
// Consulted rather than assumed, so an older runtime image keeps launching with exactly the PATH it always had.
export function ghWrapperPath(
  path: string | undefined,
  exists: (dir: string) => boolean = existsSync
): string | undefined {
  if (!exists(SANDBOX_GH_WRAPPER_DIR)) return path
  const entries = (path ?? '').split(':').filter((entry) => entry && entry !== SANDBOX_GH_WRAPPER_DIR)
  return [SANDBOX_GH_WRAPPER_DIR, ...entries].join(':')
}

/** Provider profile of the REQUESTED command (its registry identity, not the resolved path). */
export function sandboxProfile(command: string): keyof typeof SANDBOX_PROVIDER_ENV | undefined {
  const base = command.split(/[\\/]/).pop() ?? ''
  if (/^claude(?:$|[-.@])/i.test(base)) return 'claude'
  if (/^codex(?:$|[-.@])/i.test(base)) return 'codex'
  if (/^dsh(?:$|[-.@])/i.test(base)) return 'deepseek'
  return undefined
}

/** Provider env for the requested command's profile. */
export function sandboxProviderEnv(
  command: string,
  podEnv: Record<string, string | undefined>
): Record<string, string> {
  const profile = sandboxProfile(command)
  if (!profile) return {}
  const env: Record<string, string> = {}
  for (const [source, target] of Object.entries(SANDBOX_PROVIDER_ENV[profile])) {
    const value = podEnv[source]?.trim()
    if (value) env[target] = value
  }
  return env
}

// Codex reads its base URL from CODEX_CONFIG (codex-acp projects it into the session config);
// the OPENAI_BASE_URL env var is routing-inert to the pinned runtime, so a codex pod URL must
// also land in the config. Fill-in like the env loop: a daemon-aimed config stays authoritative.
export function fillInCodexBaseUrl(
  env: Record<string, string>,
  podEnv: Record<string, string | undefined>,
  warn?: (message: string) => void
): void {
  const baseUrl = podEnv.AC_CODEX_BASE_URL?.trim()
  if (!baseUrl) return
  try {
    const merged = codexConfigWithBaseUrlFillIn(env.CODEX_CONFIG, baseUrl)
    if (merged !== undefined) env.CODEX_CONFIG = merged
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warn?.(`acp: leaving the pod codex base URL unprojected — ${reason}`)
  }
}

// Deployment-asserted codex session config (AC_CODEX_CONFIG, a JSON object) — endpoint knowledge
// like "this gateway rejects a newer tool type", which only the deployment holds. Floor semantics
// match the env loop — every leaf the daemon sent stays authoritative — with shared tables merged
// one level deep, because the daemon always sends `features` (account apps off).
export function fillInCodexConfigFloor(
  env: Record<string, string>,
  podEnv: Record<string, string | undefined>,
  warn?: (message: string) => void
): void {
  const floorRaw = podEnv.AC_CODEX_CONFIG?.trim()
  if (!floorRaw) return
  try {
    const merged = codexConfigWithFloor(env.CODEX_CONFIG, floorRaw)
    if (merged !== undefined) env.CODEX_CONFIG = merged
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warn?.(`acp: leaving the pod codex config floor unapplied — ${reason}`)
  }
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
      /** Test seam: the image directory the DeepSeek preset is seeded from. */
      dshPresetSource?: string
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
    // The POD's own filesystem and locale basics, under whatever the daemon sent. The daemon
    // composes the agent's configuration but describes a different machine — it was sending its
    // own HOME, and codex then tried to open its sqlite state under a path that exists only on
    // the daemon. An allowlist rather than all of process.env: this env can carry provider
    // credentials from the SandboxTemplate, and those are forwarded deliberately by
    // sandboxProviderEnv, not in bulk.
    const env = { ...podBaseEnv(this.deps.podEnv ?? {}), ...payload.env }
    // After the daemon's env, so an agent's `gh` reaches the image's per-repo wrapper even when a PATH travelled.
    const ghPath = ghWrapperPath(env.PATH)
    if (ghPath !== undefined) env.PATH = ghPath
    for (const hint of payload.hints ?? []) {
      if (env[hint.envVar]) continue
      const resolved = this.deps.resolveCommand?.(hint.command, env)
      if (resolved) env[hint.envVar] = resolved
    }
    // Fill-in only, like hints: an env the daemon decided (per-agent key/gateway) stays authoritative.
    const podEnv = this.deps.podEnv ?? {}
    for (const [name, value] of Object.entries(sandboxProviderEnv(payload.command, podEnv))) {
      if (!env[name]) env[name] = value
    }
    // The baked browser, decided by the IMAGE like the gh wrapper dir above: the pod env is where a machine
    // the daemon is not on names its own path, and a child without it downloads a Chrome the pod already has.
    const bakedBrowser = podEnv[SANDBOX_BROWSER_EXECUTABLE_ENV]
    if (bakedBrowser && !env[SANDBOX_BROWSER_EXECUTABLE_ENV]) env[SANDBOX_BROWSER_EXECUTABLE_ENV] = bakedBrowser
    if (sandboxProfile(payload.command) === 'codex') {
      // Floor before URL: the daemon-sent config wins either way, and a floor that carries no
      // aim never blocks the base-url fill-in below.
      fillInCodexConfigFloor(env, podEnv, (message) => this.deps.log?.warn(message))
      fillInCodexBaseUrl(env, podEnv, (message) => this.deps.log?.warn(message))
      // A key without this is unusable on a fresh CODEX_HOME: codex-acp answers authRequired
      // itself only when told which method. Always the GATEWAY method — process-ephemeral, so a
      // key never becomes a shared account that outlives or races its launch. The base is the
      // FINAL effective aim, read after every fill-in above: CODEX_CONFIG's openai_base_url
      // (daemon, agent, or pod, already layered), a runtime-owned OPENAI_BASE_URL, and only then
      // the public default — and a runtime that selected its own provider composes nothing, auth
      // included. Same fill-in rule as everything here: a daemon-sent value wins.
      if (env.OPENAI_API_KEY && !env.DEFAULT_AUTH_REQUEST) {
        try {
          const config = objectFromJson(env.CODEX_CONFIG, 'CODEX_CONFIG')
          const provider = config.model_provider
          if (typeof provider !== 'string' || provider === 'openai') {
            const aimed = typeof config.openai_base_url === 'string' ? config.openai_base_url.trim() : ''
            const base = aimed || env.OPENAI_BASE_URL?.trim() || CODEX_DEFAULT_ENDPOINT
            env.DEFAULT_AUTH_REQUEST = codexGatewayAuthRequest(base, env.OPENAI_API_KEY)
          }
        } catch (error) {
          // Composing blind could aim the key at the wrong service; failing auth is recoverable.
          const reason = error instanceof Error ? error.message : String(error)
          this.deps.log?.warn(`acp: leaving the codex auth request uncomposed — ${reason}`)
        }
      }
    }
    if (sandboxProfile(payload.command) === 'deepseek') {
      // After the env is final: the seed writes under whatever `$DSH_HOME` this launch resolves to.
      seedDshPreset({
        env,
        podEnv,
        source: this.deps.dshPresetSource,
        log: { info: (m) => this.deps.log?.info(m), warn: (m) => this.deps.log?.warn(m) }
      })
    }
    const command = this.deps.resolveCommand?.(payload.command, env) ?? payload.command
    return this.spawnChild(command, payload, env)
  }

  private spawnChild(command: string, payload: AcpOpen, env: Record<string, string>): void {
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
