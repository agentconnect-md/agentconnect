import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { MAX_AUTO_MERGE_DETAIL } from '@agentconnect.md/protocol'
import { z } from 'zod'
import { GITCRED_CAPABILITY_ENV, GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import { SANDBOX_AUTO_MERGE_ENTRY, SANDBOX_TUNNEL_PATHS } from './sandbox-paths.js'

/**
 * The `automerge` capability, served IN THE POD: one watcher process per armed pull request.
 *
 * The registry is this object's own memory and the processes are its children, so the armed set
 * is exactly as long-lived as the sandbox — which is the lifetime the console projects. Nothing
 * here is written to the volume: a resumed pod must come back with nothing armed rather than
 * silently resume merging pull requests whose operator has long since moved on.
 *
 * The handler spawns rather than looping in-process because the shim is the one process the image
 * starts and it serves every other channel; a GitHub poll that threw or wedged inside it would
 * take git exec and the tunnels down with it. A child also gives the daemon an honest liveness
 * signal — `armed` is "the process is alive", not a boolean this side maintains.
 */
export const AutoMergePayloadSchema = z.object({
  // `list` asks about the POD rather than one pull request — a pod serves one agent, so "anything
  // armed here" is exactly the question the sandbox keep-alive needs answered, and answering it from
  // the registry beats a daemon-side index that a restart would silently empty.
  op: z.enum(['arm', 'disarm', 'state', 'list']),
  agentId: z.string().min(1),
  repoFullName: z.string().min(3).optional(), // required for every op but `list`
  prNumber: z.number().int().positive().optional(),
  /** The agent's runtime-only gitcred capability, so the child can fetch its own gh token per
   *  tick. Required to arm; never logged, and passed to the child through env, not argv. */
  capability: z.string().min(1).optional()
})
export type AutoMergePayload = z.infer<typeof AutoMergePayloadSchema>

/** What the daemon reads back. Deliberately the same shape the protocol frame carries, minus the
 *  identity the daemon already knows — this handler answers about the pull request it was asked
 *  about and nothing else. */
export interface AutoMergeHandlerState {
  armed: boolean
  waitingOn?: string
  lastError?: string
  merged?: boolean
  /** The pull request was closed without merging — terminal here for the same reason `merged` is. */
  closed?: boolean
}

interface Entry {
  child: ChildProcess
  status: AutoMergeHandlerState
  buffer: string
}

export interface AutoMergeHandlerDeps {
  log?: { info: (message: string) => void; warn: (message: string) => void }
  /** Seams for tests; production spawns the image's own entry with the shim's interpreter. */
  spawnChild?: (args: string[], env: NodeJS.ProcessEnv) => ChildProcess
  entryPath?: string
}

/** The refusal text an image with no watcher answers with. Exported because a shim response carries a
 *  STRING and nothing else, so the daemon side matches on it to turn this into a typed reason — one
 *  constant both halves import beats the substring literal each side would otherwise carry. */
export const AUTO_MERGE_UNSUPPORTED_IMAGE = 'this runtime image ships no in-sandbox merge-when-ready watcher'

/** How long a disarm waits for the watcher to exit on its own before SIGKILL. Generous next to a
 *  fenced tick's remaining work, and still far inside the console's own request timeout. */
export const AUTO_MERGE_DISARM_GRACE_MS = 2_000

/** Raised for a request this pod cannot serve at all, as opposed to one whose answer is "waiting".
 *  The shim maps it to a failed response and the daemon relays the reason as data. */
export class AutoMergeRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AutoMergeRefusedError'
  }
}

export function createAutoMergeHandler(
  deps: AutoMergeHandlerDeps = {}
): (payload: unknown) => Promise<AutoMergeHandlerState> {
  const entries = new Map<string, Entry>()
  const entryPath = deps.entryPath ?? SANDBOX_AUTO_MERGE_ENTRY
  const spawnChild =
    deps.spawnChild ??
    ((args, env) => spawn(process.execPath, [entryPath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }))

  const key = (p: AutoMergePayload) => `${(p.repoFullName ?? '').toLowerCase()}#${p.prNumber ?? 0}`

  return async (payload: unknown): Promise<AutoMergeHandlerState> => {
    const p = AutoMergePayloadSchema.parse(payload)
    if (p.op === 'list') return { armed: [...entries.values()].some((entry) => entry.status.armed) }
    if (!p.repoFullName || !p.prNumber) throw new AutoMergeRefusedError('this operation names a pull request')
    const id = key(p)
    const entry = entries.get(id)

    if (p.op === 'state') return entry ? { ...entry.status } : { armed: false }

    if (p.op === 'disarm') {
      // Dropped from the registry FIRST, so a concurrent `state` never reports a watcher being torn
      // down, then awaited: the child fences its own in-flight tick before exiting, so answering only
      // after it is gone means this `armed:false` cannot have a squash landing behind it.
      if (entry) {
        entries.delete(id)
        await endChild(entry.child)
      }
      return { armed: false }
    }

    if (entry) return { ...entry.status } // idempotent: arming an armed watcher keeps its process
    if (!p.capability) throw new AutoMergeRefusedError('arming needs the agent’s credential capability')
    // Reported rather than assumed: whether THIS image ships the watcher is a fact of this
    // filesystem, and an older image is version skew the daemon has to read, not guess.
    if (!existsSync(entryPath)) {
      throw new AutoMergeRefusedError(AUTO_MERGE_UNSUPPORTED_IMAGE)
    }

    const child = spawnChild([p.agentId, p.repoFullName, String(p.prNumber)], {
      ...process.env,
      [GITCRED_CAPABILITY_ENV]: p.capability,
      [GITCRED_SOCKET_ENV]: process.env[GITCRED_SOCKET_ENV] ?? SANDBOX_TUNNEL_PATHS.gitcred
    })
    const created: Entry = { child, status: { armed: true }, buffer: '' }
    entries.set(id, created)
    child.stdout?.on('data', (chunk: Buffer) => absorb(created, chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) created.status = { ...created.status, lastError: text.slice(0, MAX_AUTO_MERGE_DETAIL) }
    })
    // A watcher that exited merged the pull request, saw it closed, or died; either way nothing is
    // watching now, so the entry goes and the next `state` answers `armed:false` truthfully.
    child.on('exit', (code) => {
      const held = entries.get(id)
      if (held?.child !== child) return
      if (code !== 0 && !held.status.merged && !held.status.closed) {
        deps.log?.warn(`automerge: watcher for ${p.repoFullName}#${p.prNumber} exited with ${code}`)
      }
      entries.delete(id)
    })
    deps.log?.info(`automerge: watching ${p.repoFullName}#${p.prNumber}`)
    return { armed: true }
  }
}

/** SIGTERM, then wait for the child to actually go. Its handler fences the tick in flight before it
 *  exits, so returning only after the exit is what makes "disarmed" true rather than merely requested.
 *  SIGKILL bounds a child that ignores the signal — an answer must not wait on a wedged process. */
async function endChild(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, AUTO_MERGE_DISARM_GRACE_MS)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

/** The child reports one NDJSON status per tick; a partial line waits for its newline. */
function absorb(entry: Entry, text: string): void {
  entry.buffer += text
  for (;;) {
    const nl = entry.buffer.indexOf('\n')
    if (nl === -1) break
    const line = entry.buffer.slice(0, nl).trim()
    entry.buffer = entry.buffer.slice(nl + 1)
    if (!line) continue
    try {
      const status = JSON.parse(line) as {
        waitingOn?: string
        lastError?: string
        merged?: boolean
        closed?: boolean
      }
      entry.status = {
        // A closed pull request is as unarmed as a merged one: the child is exiting either way, and
        // reporting `armed` for the moment in between would draw a watcher that is already gone.
        armed: !status.merged && !status.closed,
        ...(status.waitingOn ? { waitingOn: status.waitingOn.slice(0, MAX_AUTO_MERGE_DETAIL) } : {}),
        ...(status.lastError ? { lastError: status.lastError.slice(0, MAX_AUTO_MERGE_DETAIL) } : {}),
        ...(status.merged ? { merged: true } : {}),
        ...(status.closed ? { closed: true } : {})
      }
    } catch {
      /* a line that is not the contract is not a status; the next tick supersedes it */
    }
  }
}
