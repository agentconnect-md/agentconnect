import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AF_UNIX_PATH_MAX } from '../acp/sandbox-temp.js'
import type { Logger } from '../log.js'
import { sweepMarkedUntilClear } from '../shim/marked-sweep.js'
import {
  SHIM_HELPER_ROOT_ENV,
  SHIM_LISTEN_SOCKET_ENV,
  SHIM_PARENT_FD_ENV,
  SHIM_RUNTIME_MARK_ENV,
  SHIM_RUNTIME_ROOT_ENV,
  SHIM_WORKSPACE_ROOT_ENV
} from '../shim/protocol.js'
import { shimPaths, type ShimPaths } from '../shim/sandbox-paths.js'

const READY_TIMEOUT_MS = 15_000
// The descriptor the shim watches for its daemon's death: the first one past stdio.
const PARENT_FD = 3
// Where a runtime root keeps its shim's mark, so a later daemon life can sweep what this one left.
const MARK_FILE = 'mark'
const MARK = /^[a-f0-9]{32}$/
// The shim ends its runtimes on SIGTERM with a 5 s deadline of its own; this waits for that before escalating.
const STOP_TIMEOUT_MS = 10_000
/** What the runtimes inherit from this machine: where its tools and locale are, never its credentials. */
const INHERITED_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ'] as const
const HELPER_KEYS: ReadonlyArray<Exclude<keyof ShimPaths, 'tunnels'>> = [
  'gitCredentialHelper',
  'ghTokenEntry',
  'autoMergeEntry',
  'mcpBridgeEntry',
  'ghWrapperDir',
  'dshPresetDir'
]

/** Why this machine offers no `host` strategy (session-executors.md §5), or undefined on Linux. */
export function hostShimUnavailableReason(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'linux') return undefined
  return `the host strategy needs Linux: the shim's console read path is fd-bound and its helper locations are image-fixed`
}

/** A session's shim started as a plain child of this daemon, with no sandbox around it (architecture.md §9.1). */
export interface HostShim {
  /** The unix socket the shim accepts its daemon on; it is inside the runtime root, so nothing outside this user reaches it. */
  socketPath: string
  /** The per-session root the shim binds its tunnel sockets and writes its Git config under; removed when the shim goes. */
  runtimeRoot: string
  /** Where this installation's helper entries live; a holder derives their paths from it with `shimPaths`. */
  helperRoot: string
  workspaceRoot: string
  /** The one-time identity the shim presents; the dialer's verifier accepts exactly this. */
  token: string
  /** Helper locations `shimPaths` derives that this installation has nothing at, so a caller must not configure them. */
  missingHelpers: Array<keyof ShimPaths>
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Ends the shim's process group, waits for it, and removes the runtime root; the workspace stays. */
  stop(): Promise<void>
}

export interface HostShimInput {
  daemonRoot: string
  /** The session's leaf under `<daemonRoot>/sessions`; `{workspace,repos,home}` are created beneath it. */
  sessionLeaf: string
  /** The machine environment the runtimes inherit from; only `INHERITED_ENV` is read. */
  env?: Record<string, string | undefined>
  /** What seeding the session HOME points a runtime at on this machine; the shim fills it in under a holder's env. */
  seedEnv?: Record<string, string>
  log?: Logger
  /** Test seam: the shim entry and how to run it; the default is this daemon's built bundle. */
  entry?: { execArgv: string[]; path: string }
}

/** The shim's launch environment: its own sockets and roots, the machine facts above and what the HOME seed points at — never the complete-env flag, which is a holder's claim about ITS machine. */
export function hostShimEnv(input: {
  machineEnv: Record<string, string | undefined>
  seedEnv?: Record<string, string>
  home: string
  socketPath: string
  runtimeRoot: string
  workspaceRoot: string
  helperRoot: string
  mark: string
}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of INHERITED_ENV) {
    const value = input.machineEnv[name]
    if (value) env[name] = value
  }
  // Before the shim's own variables, so a seed can name no socket, root or HOME.
  Object.assign(env, input.seedEnv)
  env.HOME = input.home
  env[SHIM_LISTEN_SOCKET_ENV] = input.socketPath
  env[SHIM_RUNTIME_ROOT_ENV] = input.runtimeRoot
  env[SHIM_WORKSPACE_ROOT_ENV] = input.workspaceRoot
  env[SHIM_HELPER_ROOT_ENV] = input.helperRoot
  env[SHIM_RUNTIME_MARK_ENV] = input.mark
  env[SHIM_PARENT_FD_ENV] = String(PARENT_FD)
  return env
}

/** Runtime roots whose shim this process started and has not seen go. */
const liveRoots = new Set<string>()

/** End what an earlier daemon life left behind: each stale runtime root's marked processes — its shim included — then the root. */
export async function sweepStaleHostShims(daemonRoot: string, log?: Pick<Logger, 'info'>): Promise<void> {
  const dir = join(daemonRoot, 'hs')
  for (const name of await readdir(dir).catch(() => [])) {
    const runtimeRoot = join(dir, name)
    if (liveRoots.has(runtimeRoot)) continue
    const mark = (await readFile(join(runtimeRoot, MARK_FILE), 'utf8').catch(() => '')).trim()
    // Only a mark this launcher could have minted is looked for; the sweep itself matches it exactly.
    if (MARK.test(mark)) await sweepMarkedUntilClear(mark)
    await rm(runtimeRoot, { recursive: true, force: true })
    log?.info(`host shim: removed the runtime root ${name} an earlier run left behind`)
  }
}

// The same two candidates the VM starter stages from: beside this module in dist, or the package's dist from source.
function builtShimEntry(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  for (const path of [join(moduleDir, 'shim', 'index.js'), join(moduleDir, '../../dist/shim/index.js')]) {
    if (existsSync(path)) return path
  }
  throw new Error('the host strategy requires the bundled shim; build the daemon before starting it')
}

export async function startHostShim(input: HostShimInput): Promise<HostShim> {
  const unavailable = hostShimUnavailableReason()
  if (unavailable) throw new Error(unavailable)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.sessionLeaf)) throw new Error('invalid session leaf')
  const entry = input.entry ?? { execArgv: [], path: builtShimEntry() }
  // The helper root is the entry's grandparent: `<root>/shim/index.js` is the layout both the image and dist share.
  const helperRoot = dirname(dirname(entry.path))
  const paths = shimPaths(undefined, helperRoot)
  const missingHelpers = HELPER_KEYS.filter((key) => !existsSync(paths[key]))
  // Short and beside the sessions, not under a HOME: every tunnel socket beneath it must fit the AF_UNIX budget.
  const runtimeRoot = join(input.daemonRoot, 'hs', randomBytes(6).toString('hex'))
  const longest = Object.values(shimPaths(runtimeRoot).tunnels).reduce((a, b) => (b.length > a.length ? b : a))
  if (Buffer.byteLength(longest) > AF_UNIX_PATH_MAX) throw new Error('daemon root is too long for a host shim socket')
  const socketPath = join(runtimeRoot, 'shim.sock')
  const workspaceRoot = join(input.daemonRoot, 'sessions', input.sessionLeaf)
  const home = join(workspaceRoot, 'home')
  const token = randomBytes(32).toString('base64url')
  // Not the identity token: every runtime's environment carries this, and the identity must reach none of them.
  const mark = randomBytes(16).toString('hex')
  liveRoots.add(runtimeRoot)
  try {
    await mkdir(dirname(runtimeRoot), { recursive: true, mode: 0o700 })
    await mkdir(runtimeRoot, { mode: 0o700 })
    // Written before the shim exists, so no crash leaves a marked process a restart cannot find.
    await writeFile(join(runtimeRoot, MARK_FILE), mark, { mode: 0o600 })
    for (const dir of ['workspace', 'repos', 'home'])
      await mkdir(join(workspaceRoot, dir), { recursive: true, mode: 0o700 })
  } catch (error) {
    liveRoots.delete(runtimeRoot)
    throw error
  }
  const log = input.log
  const child: ChildProcess = spawn(process.execPath, [...entry.execArgv, entry.path, '--identity-stdin'], {
    cwd: workspaceRoot,
    env: hostShimEnv({
      machineEnv: input.env ?? process.env,
      ...(input.seedEnv ? { seedEnv: input.seedEnv } : {}),
      home,
      socketPath,
      runtimeRoot,
      workspaceRoot,
      helperRoot,
      mark
    }),
    // The fourth is never written: the kernel closes this end when the daemon dies, however it dies, and the shim reads that as its cue to go.
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    // Its own group, so stop can end whatever it spawned in one signal.
    detached: true
  })
  child.stdio[PARENT_FD]?.on('error', () => {})
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    // A child that never spawned has no exit to wait for.
    child.once('error', () => resolve({ code: null, signal: null }))
  })
  // Whenever the shim goes — a stop, a crash, a failed start — what it left running goes before its root does.
  const removed = exited.then(async () => {
    await sweepMarkedUntilClear(mark)
    liveRoots.delete(runtimeRoot)
    await rm(runtimeRoot, { recursive: true, force: true })
  })
  void removed.catch(() => {})
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((yes, no) => {
    resolveReady = yes
    rejectReady = no
  })
  void ready.catch(() => {})
  child.once('error', (error) => rejectReady(error))
  void exited.then(() => rejectReady(new Error('host shim exited before it was ready')))
  let output: string | undefined = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    if (output === undefined) return
    output += chunk.toString()
    if (output.startsWith('ready\n')) {
      output = undefined
      resolveReady()
    } else if (!'ready\n'.startsWith(output)) rejectReady(new Error('invalid host shim readiness response'))
  })
  let tail = ''
  child.stderr!.on('data', (chunk: Buffer) => {
    const lines = (tail + chunk.toString()).split('\n')
    tail = lines.pop() ?? ''
    for (const line of lines) log?.debug(`host shim ${input.sessionLeaf}: ${line}`)
  })
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      /* group already gone */
    }
  }
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      signalGroup('SIGTERM')
      const timer = setTimeout(() => signalGroup('SIGKILL'), STOP_TIMEOUT_MS)
      try {
        await exited
      } finally {
        clearTimeout(timer)
      }
      signalGroup('SIGKILL')
      await removed
    })())
  const timer = setTimeout(() => rejectReady(new Error('host shim startup timed out')), READY_TIMEOUT_MS)
  try {
    child.stdin!.end(token)
    await ready
  } catch (error) {
    await stop()
    throw error
  } finally {
    clearTimeout(timer)
  }
  return { socketPath, runtimeRoot, helperRoot, workspaceRoot, token, missingHelpers, exited, stop }
}
