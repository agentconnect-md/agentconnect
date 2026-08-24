// The in-pod half: the `automerge` capability spawns ONE watcher process per armed pull request, and
// its liveness IS the armed fact. Nothing is written to the pod's volume, so a resumed sandbox comes
// back with nothing armed rather than silently resuming merges nobody is waiting for.
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { AUTO_MERGE_DISARM_GRACE_MS, createAutoMergeHandler } from '../src/shim/auto-merge-handler.js'
import { GITCRED_CAPABILITY_ENV } from '../src/gitcred/env.js'

/** A child process double: stdout/stderr streams plus an `exit` the test can fire. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: (signal?: string) => void
    killed: string[]
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = []
  child.kill = (signal?: string) => {
    child.killed.push(signal ?? 'SIGTERM')
    // A real child answers SIGTERM by exiting, and the handler's disarm waits for exactly that.
    if (signal !== 'SIGKILL') setImmediate(() => child.emit('exit', 0))
  }
  return child
}

/** A child that ignores SIGTERM, so a disarm cannot rely on it going quietly. */
function wedgedChild() {
  const child = fakeChild()
  child.kill = (signal?: string) => {
    child.killed.push(signal ?? 'SIGTERM')
  }
  return child
}

function build() {
  const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv; child: ReturnType<typeof fakeChild> }> = []
  const handler = createAutoMergeHandler({
    entryPath: import.meta.filename, // an entry that exists, so the image check passes
    spawnChild: (args, env) => {
      const child = fakeChild()
      spawned.push({ args, env, child })
      return child as never
    }
  })
  return { handler, spawned }
}

const ARM = { op: 'arm' as const, agentId: 'agent-1', repoFullName: 'acme/repo', prNumber: 7, capability: 'cap_secret' }
const READ = { op: 'state' as const, agentId: 'agent-1', repoFullName: 'acme/repo', prNumber: 7 }

describe('in-sandbox automerge handler', () => {
  it('spawns one watcher per pull request and keeps the capability off argv', async () => {
    const { handler, spawned } = build()

    expect(await handler(ARM)).toEqual({ armed: true })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.args).toEqual(['agent-1', 'acme/repo', '7'])
    // The credential capability is a secret: env, never argv, where any process listing would show it.
    expect(spawned[0]!.args.join(' ')).not.toContain('cap_secret')
    expect(spawned[0]!.env[GITCRED_CAPABILITY_ENV]).toBe('cap_secret')

    // Idempotent: arming an armed watcher keeps the process it already has.
    expect(await handler(ARM)).toEqual({ armed: true })
    expect(spawned).toHaveLength(1)
  })

  it('projects the watcher’s NDJSON status back to the daemon', async () => {
    const { handler, spawned } = build()
    await handler(ARM)
    const child = spawned[0]!.child

    // A partial line waits for its newline rather than being read as a status.
    child.stdout.emit('data', Buffer.from('{"merged":false,"waitingOn":"checks run'))
    expect(await handler(READ)).toEqual({ armed: true })
    child.stdout.emit('data', Buffer.from('ning: build"}\n'))
    expect(await handler(READ)).toEqual({ armed: true, waitingOn: 'checks running: build' })

    child.stderr.emit('data', Buffer.from('no gh credentials\n'))
    expect(await handler(READ)).toMatchObject({ armed: true, lastError: 'no gh credentials' })
  })

  it('reports merged, then drops the entry when the watcher exits', async () => {
    const { handler, spawned } = build()
    await handler(ARM)
    const child = spawned[0]!.child

    child.stdout.emit('data', Buffer.from('{"merged":true}\n'))
    expect(await handler(READ)).toEqual({ armed: false, merged: true })

    child.emit('exit', 0)
    expect(await handler(READ)).toEqual({ armed: false })
  })

  it('a killed pod reads back unarmed — the exit is the whole state machine', async () => {
    const { handler, spawned } = build()
    await handler(ARM)
    spawned[0]!.child.emit('exit', 143)
    expect(await handler(READ)).toEqual({ armed: false })
  })

  it('disarm kills the watcher and answers unarmed', async () => {
    const { handler, spawned } = build()
    await handler(ARM)

    expect(await handler({ ...READ, op: 'disarm' })).toEqual({ armed: false })
    expect(spawned[0]!.child.killed).toEqual(['SIGTERM'])
    expect(await handler(READ)).toEqual({ armed: false })
  })

  it('exits the entry on a CLOSED pull request, so a reopened one can be armed again', async () => {
    const { handler, spawned } = build()
    await handler(ARM)
    const child = spawned[0]!.child

    // The child reports closed and exits; both halves must read it as terminal, not as armed.
    child.stdout.emit('data', Buffer.from('{"merged":false,"closed":true,"waitingOn":"the pull request was closed"}\n'))
    expect(await handler(READ)).toEqual({
      armed: false,
      closed: true,
      waitingOn: 'the pull request was closed'
    })
    child.emit('exit', 0)
    expect(await handler(READ)).toEqual({ armed: false })

    // Reopened: arming spawns a NEW watcher rather than returning the dead entry's state.
    expect(await handler(ARM)).toEqual({ armed: true })
    expect(spawned).toHaveLength(2)
  })

  it('waits for the watcher to actually go before answering a disarm', async () => {
    const { handler, spawned } = build()
    await handler(ARM)

    expect(await handler({ ...READ, op: 'disarm' })).toEqual({ armed: false })
    // The child fences its own in-flight tick before exiting, so answering after the exit is what
    // makes "disarmed" a fact rather than a request that a merge could still outrun.
    expect(spawned[0]!.child.killed).toEqual(['SIGTERM'])
  })

  it('SIGKILLs a watcher that ignores SIGTERM instead of hanging the disarm', async () => {
    const spawned: ReturnType<typeof wedgedChild>[] = []
    const handler = createAutoMergeHandler({
      entryPath: import.meta.filename,
      spawnChild: () => {
        const child = wedgedChild()
        spawned.push(child)
        return child as never
      }
    })
    await handler(ARM)

    vi.useFakeTimers()
    try {
      const answered = handler({ ...READ, op: 'disarm' })
      await vi.advanceTimersByTimeAsync(AUTO_MERGE_DISARM_GRACE_MS)
      expect(await answered).toEqual({ armed: false })
    } finally {
      vi.useRealTimers()
    }
    expect(spawned[0]!.killed).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('refuses to arm without a capability, and on an image that ships no watcher', async () => {
    const { handler } = build()
    await expect(handler({ ...ARM, capability: undefined })).rejects.toThrow(/credential capability/)

    const old = createAutoMergeHandler({
      entryPath: '/opt/agentconnect/shim/does-not-exist.js',
      spawnChild: () => fakeChild() as never
    })
    await expect(old(ARM)).rejects.toThrow(/ships no in-sandbox/)
  })

  it('answers `list` with whether ANYTHING is armed in this pod — the keep-alive’s question', async () => {
    const { handler, spawned } = build()
    const list = { op: 'list' as const, agentId: 'agent-1' }
    expect(await handler(list)).toEqual({ armed: false })

    await handler(ARM)
    expect(await handler(list)).toEqual({ armed: true })

    // The pod is the source of truth: once the watcher exits, `list` says so on the next ask.
    spawned[0]!.child.emit('exit', 0)
    expect(await handler(list)).toEqual({ armed: false })
  })

  it('answers `state` for a pull request nobody armed without spawning anything', async () => {
    const { handler, spawned } = build()
    expect(await handler(READ)).toEqual({ armed: false })
    expect(spawned).toHaveLength(0)
  })
})
