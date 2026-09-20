import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AF_UNIX_PATH_MAX } from '../acp/sandbox-temp.js'
import type { Logger } from '../log.js'
import {
  SHIM_HELPER_ROOT_ENV,
  SHIM_LISTEN_SOCKET_ENV,
  SHIM_RUNTIME_MARK_ENV,
  SHIM_RUNTIME_ROOT_ENV,
  SHIM_WORKSPACE_ROOT_ENV
} from '../shim/protocol.js'
import { shimPaths, type ShimPaths } from '../shim/sandbox-paths.js'

const READY_TIMEOUT_MS = 15_000
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
  log?: Logger
  /** Test seam: the shim entry and how to run it; the default is this daemon's built bundle. */
  entry?: { execArgv: string[]; path: string }
}

/** The shim's launch environment: its own sockets and roots, and the machine facts above — never the complete-env flag, which is a holder's claim about ITS machine. */
export function hostShimEnv(input: {
  machineEnv: Record<string, string | undefined>
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
  env.HOME = input.home
  env[SHIM_LISTEN_SOCKET_ENV] = input.socketPath
  env[SHIM_RUNTIME_ROOT_ENV] = input.runtimeRoot
  env[SHIM_WORKSPACE_ROOT_ENV] = input.workspaceRoot
  env[SHIM_HELPER_ROOT_ENV] = input.helperRoot
  env[SHIM_RUNTIME_MARK_ENV] = input.mark
  return env
}

/** SIGKILL every process of this user whose environment carries exactly this mark; returns how many it signalled. */
// For crashes, not containment: runtimes lead their own groups, so a dead shim's group signal cannot reach them.
// A process that clears its environment and re-parents escapes, as it does from the daemon's own unsandboxed launch (architecture.md §9.1).
export async function sweepMarked(mark: string): Promise<number> {
  const entry = `${SHIM_RUNTIME_MARK_ENV}=${mark}`
  let killed = 0
  for (const name of await readdir('/proc').catch(() => [])) {
    const pid = Number(name)
    if (!Number.isInteger(pid) || pid === process.pid) continue
    try {
      // Read at kill time, so a recycled pid is never signalled; another user's process is unreadable and skipped.
      const environ = await readFile(`/proc/${pid}/environ`, 'latin1')
      if (!environ.split('\0').includes(entry)) continue
      // Field 5 of stat, counted after the parenthesised command, is the process group.
      const stat = await readFile(`/proc/${pid}/stat`, 'latin1')
      const pgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2])
      process.kill(pgid === pid ? -pid : pid, 'SIGKILL')
      killed++
    } catch {
      /* gone, or not ours to read */
    }
  }
  return killed
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
  await mkdir(dirname(runtimeRoot), { recursive: true, mode: 0o700 })
  await mkdir(runtimeRoot, { mode: 0o700 })
  for (const dir of ['workspace', 'repos', 'home'])
    await mkdir(join(workspaceRoot, dir), { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString('base64url')
  // Not the identity token: every runtime's environment carries this, and the identity must reach none of them.
  const mark = randomBytes(16).toString('hex')
  const log = input.log
  const child: ChildProcess = spawn(process.execPath, [...entry.execArgv, entry.path, '--identity-stdin'], {
    cwd: workspaceRoot,
    env: hostShimEnv({
      machineEnv: input.env ?? process.env,
      home,
      socketPath,
      runtimeRoot,
      workspaceRoot,
      helperRoot,
      mark
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own group, so stop can end whatever it spawned in one signal.
    detached: true
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    // A child that never spawned has no exit to wait for.
    child.once('error', () => resolve({ code: null, signal: null }))
  })
  // Whenever the shim goes — a stop, a crash, a failed start — what it left running goes before its root does.
  const removed = exited.then(async () => {
    // Again while a pass finds something: a match may have forked between the scan and its kill.
    for (let pass = 0; pass < 5 && (await sweepMarked(mark)) > 0; pass++);
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
  return { socketPath, runtimeRoot, workspaceRoot, token, missingHelpers, exited, stop }
}
