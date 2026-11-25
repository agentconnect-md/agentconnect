import { describe, expect, it } from 'vitest'
import { AgentWorkspaceScheduler } from '../src/workspace/agent-workspace-scheduler.js'

/** An operation the test finishes by hand, recording when it started. */
function gate(log: string[], name: string) {
  let finish!: () => void
  let fail!: (err: Error) => void
  const done = new Promise<string>((resolve, reject) => {
    finish = () => resolve(name)
    fail = reject
  })
  return {
    run: () => {
      log.push(`start ${name}`)
      return done
    },
    finish,
    fail
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('AgentWorkspaceScheduler', () => {
  it('prepares sessions with their own directories side by side, up to its limit', async () => {
    const log: string[] = []
    const scheduler = new AgentWorkspaceScheduler(2)
    const [a, b, c] = ['a', 'b', 'c'].map((n) => gate(log, n))
    const runs = [
      scheduler.shared('agent', 'a', a!.run),
      scheduler.shared('agent', 'b', b!.run),
      scheduler.shared('agent', 'c', c!.run)
    ]
    await settle()
    expect(log).toEqual(['start a', 'start b'])
    a!.finish()
    await settle()
    expect(log).toEqual(['start a', 'start b', 'start c'])
    b!.finish()
    c!.finish()
    expect(await Promise.all(runs)).toEqual(['a', 'b', 'c'])
    expect(scheduler.busy('agent')).toBe(false)
  })

  it('runs exclusive work alone, and never lets a later session overtake it', async () => {
    const log: string[] = []
    const scheduler = new AgentWorkspaceScheduler(4)
    const first = gate(log, 'first')
    const generation = gate(log, 'generation')
    const later = gate(log, 'later')
    const runs = [
      scheduler.shared('agent', 'first', first.run),
      scheduler.exclusive('agent', generation.run),
      scheduler.shared('agent', 'later', later.run)
    ]
    await settle()
    expect(log).toEqual(['start first'])
    first.finish()
    await settle()
    expect(log).toEqual(['start first', 'start generation'])
    generation.finish()
    await settle()
    expect(log).toEqual(['start first', 'start generation', 'start later'])
    later.finish()
    await Promise.all(runs)
  })

  it('keeps agents apart and releases a lane when its work fails', async () => {
    const log: string[] = []
    const scheduler = new AgentWorkspaceScheduler(1)
    const broken = gate(log, 'broken')
    const other = gate(log, 'other')
    const next = gate(log, 'next')
    const failed = scheduler.exclusive('a', broken.run)
    const elsewhere = scheduler.exclusive('b', other.run)
    const after = scheduler.shared('a', 'next', next.run)
    await settle()
    expect(log).toEqual(['start broken', 'start other'])
    broken.fail(new Error('clone failed'))
    await expect(failed).rejects.toThrow('clone failed')
    await settle()
    expect(log).toContain('start next')
    other.finish()
    next.finish()
    await Promise.all([elsewhere, after])
  })

  it('reports idle only once every queued and running operation has settled', async () => {
    const log: string[] = []
    const scheduler = new AgentWorkspaceScheduler(2)
    const a = gate(log, 'a')
    const b = gate(log, 'b')
    void scheduler.shared('agent', 'a', a.run)
    void scheduler.exclusive('agent', b.run)
    let idle = false
    void scheduler.allIdle().then(() => (idle = true))
    a.finish()
    await settle()
    expect(idle).toBe(false)
    b.finish()
    await scheduler.idle('agent')
    await settle()
    expect(idle).toBe(true)
  })

  it('counts an operation that throws before returning a promise as failed', async () => {
    const scheduler = new AgentWorkspaceScheduler(1)
    await expect(
      scheduler.exclusive('agent', () => {
        throw new Error('superseded')
      })
    ).rejects.toThrow('superseded')
    expect(await scheduler.shared('agent', 'next', async () => 'next')).toBe('next')
  })

  it("holds a session's retry behind its own stale preparation, without holding other sessions", async () => {
    const log: string[] = []
    const scheduler = new AgentWorkspaceScheduler(4)
    const stale = gate(log, 'stale')
    const retry = gate(log, 'retry')
    const other = gate(log, 'other')
    const runs = [scheduler.shared('agent', 'x', stale.run), scheduler.shared('agent', 'x', retry.run)]
    await settle()
    expect(log).toEqual(['start stale'])
    stale.finish()
    await settle()
    expect(log).toEqual(['start stale', 'start retry'])
    runs.push(scheduler.shared('agent', 'y', other.run))
    await settle()
    expect(log).toEqual(['start stale', 'start retry', 'start other'])
    retry.finish()
    other.finish()
    await Promise.all(runs)
  })
})
