import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, win32 as windowsPath } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { LocalFileSink } from '../shim/file-sink.js'
import { resolveCommandPath } from '../runtimes/probe.js'
import { sandboxWrap, type SandboxMechanism } from './sandbox.js'
import type { ClaudeProtectedSettings } from '../runtime-defs/claude-runtime.js'
import type { Logger } from '../log.js'

export interface AcpSandboxLaunch {
  mechanism: SandboxMechanism
  writable: string[]
  /** Common filesystem policy, consumed through SRT settings. */
  denyReadRoots?: string[]
  allowReadRoots?: string[]
  /** Trusted SRT policy for ordinary ACP hosts. */
  settingsPath?: string
  /** Trusted working directory used to anchor SRT's Linux mandatory-deny scan. */
  cwd?: string
  /** Credential paths available to the trusted ACP runtime itself but denied to
   * model-authored commands by a runtime-native nested sandbox. */
  protectedCredentialRoots?: string[]
  /** A deliberately exposed model-side Unix channel, currently gitcred.sock for
   * GitHub App workspaces. Linux SRT cannot allow AF_UNIX by pathname. */
  allowModelToolUnixSockets?: boolean
  /** SDK flag settings that pin protected parent-only profile selection after
   * Claude merges workspace-controlled settings. */
  claudeProtectedSettings?: ClaudeProtectedSettings
}

/**
 * One env pointer the runtime needs filled with an executable path, resolved in
 * the TARGET's filesystem rather than the daemon's. Only applied when the caller
 * left the variable unset.
 */
export interface ExecutableHint {
  envVar: string
  command: string
}

/** One daemon-decided file the driver must write in the TARGET filesystem before the runtime starts. */
export interface SpawnFile {
  root: string
  relPath: string[]
  content: string
}

export interface SpawnRequest {
  command: string
  args: string[]
  /** The complete child environment; the driver adds nothing but resolved hints. */
  env: Record<string, string>
  hints?: ExecutableHint[]
  /** Files env pointers reference (session gitconfig): the daemon decides the content, but only the
   *  driver knows whose filesystem the runtime reads, so the write travels with the launch. */
  files?: SpawnFile[]
  /** Disposable probes suppress raw stderr so a harness cannot print credential
   *  material or host paths outside our sanitizer. */
  suppressChildStderr?: boolean
  /** OS sandbox for the agent process (issue #312). Absent ⇒ run unconfined. */
  sandbox?: AcpSandboxLaunch
}

/** A launched ACP runtime, reduced to what the protocol layer actually needs. */
export interface SpawnedRuntime {
  /** ND-JSON byte streams carrying ACP in both directions. */
  toAgent: WritableStream<Uint8Array>
  fromAgent: ReadableStream<Uint8Array>
  /** Fires once when the runtime reaches terminal exit on its own. */
  onExit(listener: () => void): void
  /** Graceful stop escalating past the deadline. Safe to call on a dead target. */
  stop(deadlineMs: number): Promise<void>
}

/**
 * Where an ACP runtime runs. `LocalDriver` is a child process on this host; a
 * cluster driver launches it in a sandbox pod and carries ACP over the network.
 * The seam is deliberately narrow — the protocol layer wants a byte stream pair
 * and a lifecycle, and everything filesystem- or process-shaped lives below it.
 */
export interface SpawnDriver {
  launch(request: SpawnRequest): Promise<SpawnedRuntime>
}

/** Resolve a local command without a shell; Windows npm shims are Node scripts behind `.cmd`. */
export function resolveLocalInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  nodeExecPath = process.execPath,
  fileExists: (path: string) => boolean = existsSync
): { cmd: string; args: string[] } {
  const resolved = resolveCommandPath(command, env) ?? command
  const pathApi = platform === 'win32' ? windowsPath : { basename, dirname, join }
  if (platform === 'win32' && pathApi.basename(resolved).toLowerCase() === 'npx.cmd') {
    const cli = pathApi.join(pathApi.dirname(resolved), 'node_modules', 'npm', 'bin', 'npx-cli.js')
    if (fileExists(cli)) return { cmd: nodeExecPath, args: [cli, ...args] }
  }
  return { cmd: resolved, args }
}

/** Canonicalize the case-insensitive process keys that plain Windows env objects expose with arbitrary casing. */
export function canonicalizeWindowsSpawnEnv(env: Record<string, string>, platform = process.platform): void {
  if (platform !== 'win32') return
  for (const canonical of ['PATH', 'PATHEXT', 'SystemRoot']) {
    const found = Object.keys(env).find((name) => name.toLowerCase() === canonical.toLowerCase())
    if (!found) continue
    const value = env[found]!
    if (found !== canonical) delete env[found]
    env[canonical] = value
  }
}

/** Drop TOML overrides that codex-acp's Windows `shell:true` launcher would split into subcommands. */
export function sanitizeWindowsCodexAdapterEnv(
  env: Record<string, string>,
  hints: ExecutableHint[] = [],
  platform = process.platform
): boolean {
  if (platform !== 'win32' || !hints.some((hint) => hint.envVar === 'CODEX_PATH')) return false
  return delete env.CODEX_ACP_PERMISSION_PROFILE_CONFIG
}

/** Resolve the native Codex binary behind a global npm `.cmd` shim. */
export function resolveWindowsCodexNative(
  resolved: string,
  platform = process.platform,
  arch = process.arch,
  fs: { exists(path: string): boolean; realpath(path: string): string } = {
    exists: existsSync,
    realpath: (path) => realpathSync(path)
  }
): string | undefined {
  if (platform !== 'win32' || windowsPath.basename(resolved).toLowerCase() !== 'codex.cmd') return undefined
  const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : arch === 'x64' ? 'x86_64-pc-windows-msvc' : undefined
  const pkg = arch === 'arm64' ? 'codex-win32-arm64' : arch === 'x64' ? 'codex-win32-x64' : undefined
  if (!target || !pkg) return undefined
  const native = windowsPath.join(
    windowsPath.dirname(resolved),
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    '@openai',
    pkg,
    'vendor',
    target,
    'bin',
    'codex.exe'
  )
  return fs.exists(native) ? fs.realpath(native) : undefined
}

/** The ACP runtime as a child process of this daemon: today's only behavior. */
export class LocalDriver implements SpawnDriver {
  constructor(private opts: { log?: Logger } = {}) {}

  async launch(request: SpawnRequest): Promise<SpawnedRuntime> {
    const sink = new LocalFileSink()
    for (const file of request.files ?? []) await sink.write(file.root, file.relPath, file.content)
    const env = { ...request.env }
    canonicalizeWindowsSpawnEnv(env)
    if (sanitizeWindowsCodexAdapterEnv(env, request.hints)) {
      this.opts.log?.warn(
        'acp: disabled Codex permission-profile CLI overrides on Windows because codex-acp uses cmd.exe'
      )
    }
    for (const hint of request.hints ?? []) {
      if (env[hint.envVar]) continue
      const resolved = resolveCommandPath(hint.command, env)
      if (!resolved) continue
      env[hint.envVar] = hint.envVar === 'CODEX_PATH' ? (resolveWindowsCodexNative(resolved) ?? resolved) : resolved
      this.opts.log?.info(`acp: ${hint.envVar} not set — using ${hint.command} on PATH (${resolved})`)
    }
    // Resolve the command to an absolute path (or a path-qualified relative one for
    // auto-downloaded archives), so ACP registry binary commands with a `./` prefix
    // ("./opencode", "./goose", …) are not resolved against CWD only and missed on
    // `$PATH`. Falls back to the raw command when resolution fails — spawn's own
    // error surface is clearer than a synthetic one.
    const invocation = resolveLocalInvocation(request.command, request.args, env)
    const resolvedCommand = invocation.cmd
    const resolved = request.sandbox && existsSync(resolvedCommand) ? realpathSync(resolvedCommand) : resolvedCommand
    // Linux SRT sandbox (issue #312). Fail-open — ensureHost only sets sandbox after a
    // live probe, so no mechanism means the adapter runs unconfined unless daemon
    // policy required sandboxing and refused startup.
    const launch = request.sandbox
      ? sandboxWrap(resolved, invocation.args, request.sandbox)
      : { cmd: resolved, args: invocation.args }
    const child = spawn(launch.cmd, launch.args, {
      stdio: ['pipe', 'pipe', request.suppressChildStderr ? 'ignore' : 'inherit'],
      env,
      // Own process group (POSIX): a foreground daemon's Ctrl-C sends SIGINT to the
      // whole terminal group, which killed adapters out from under the graceful
      // drain; and stop()'s escalation must reach the full tree — npx-distributed
      // runtimes run the real adapter as a grandchild of the npm wrapper, and
      // SIGKILLing just the wrapper orphans the adapter. The group id (= child pid)
      // lets stop() signal wrapper + adapter + their children in one kill.
      detached: process.platform !== 'win32'
    })
    child.once('exit', () => {
      // Sweep group survivors (an adapter orphaned by its npx wrapper's death) NOW:
      // moments after the leader exits its pgid cannot have been recycled — a pgid
      // stays reserved while any member lives — so this can never hit a stranger.
      // A later sweep could (pid reuse), which is why stop() never signals a child
      // it found already dead.
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          /* group already empty */
        }
      }
    })

    if (!child.stdin || !child.stdout) {
      throw new Error('AcpHost: subprocess stdin/stdout are not piped')
    }
    return new LocalSpawnedRuntime(child, this.opts.log)
  }
}

class LocalSpawnedRuntime implements SpawnedRuntime {
  readonly toAgent: WritableStream<Uint8Array>
  readonly fromAgent: ReadableStream<Uint8Array>
  private stopped = false
  /** Set when the command never became a process, so there is nothing to signal. */
  private neverStarted = false

  constructor(
    private child: ChildProcess,
    private log?: Logger
  ) {
    this.toAgent = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>
    this.fromAgent = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>
    // A command that cannot be executed — missing binary, no execute bit, or a script
    // whose shebang interpreter is gone — emits 'error' and never 'exit'. Node rethrows
    // an unhandled 'error' event as an uncaught exception, so one broken runtime on
    // PATH would kill the daemon and every agent it hosts. Fail this launch alone:
    // destroying the pipes hands the real errno to whoever reads the stream pair,
    // which is the only failure channel this seam has.
    child.once('error', (err: Error) => {
      this.neverStarted = true
      this.log?.warn(`acp: ${child.spawnfile} failed to start — ${err.message}`)
      child.stdin?.destroy(err)
      child.stdout?.destroy(err)
    })
  }

  onExit(listener: () => void): void {
    // 'close' as well as 'exit': a child that never started emits only 'close', and a
    // waiter that listens for 'exit' alone would hang there forever.
    let fired = false
    const once = () => {
      if (fired) return
      fired = true
      listener()
    }
    this.child.once('exit', once)
    this.child.once('close', once)
  }

  async stop(deadlineMs: number): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const child = this.child
    // Group signal when the child has its own group (detached spawn); fall back to
    // the direct child on win32 or once the group is gone (ESRCH).
    const kill = (sig: NodeJS.Signals) => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, sig)
          return
        } catch {
          /* group already gone — try the direct child */
        }
      }
      child.kill(sig)
    }
    // A child that already exited on its own has emitted 'exit' already: once('exit')
    // below would never fire and stop() would hang the daemon forever, kill() being a
    // no-op on a reaped pid. No group sweep here — the child may have been dead for
    // minutes (idle sweep cadence) and its pgid recycled to an unrelated process;
    // the spawn-time 'exit' listener already swept while the pgid was provably ours.
    if (child.exitCode !== null || child.signalCode !== null) return
    // A failed spawn leaves both codes null forever: there is no pid to signal, and
    // waiting below would burn the full deadline and then warn about a SIGTERM that
    // no process ever ignored.
    if (this.neverStarted) return
    // Graceful first: ACP is a stdio protocol, EOF on stdin is the idiomatic "we're
    // done" and propagates through an npx wrapper to the adapter. The web-stream
    // wrapper may hold the pipe locked mid-write — then the signals below still land.
    try {
      child.stdin?.end()
    } catch {
      /* stream locked/destroyed — signals still land */
    }
    kill('SIGTERM')
    await new Promise<void>((resolve) => {
      let settled = false
      let killFailsafe: NodeJS.Timeout | undefined
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(killFailsafe)
        resolve()
      }
      const timer = setTimeout(() => {
        this.log?.warn(`acp: child ignored SIGTERM after ${deadlineMs}ms — sending SIGKILL`)
        kill('SIGKILL')
        // SIGKILL on a live child always ends in 'exit'; the failsafe only covers a
        // kill with nothing left to hit, so stop() resolves no matter what.
        killFailsafe = setTimeout(done, 2000)
      }, deadlineMs)
      child.once('exit', done)
    })
  }
}
