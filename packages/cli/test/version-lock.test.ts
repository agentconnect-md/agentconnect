import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withVersionLock } from '../src/version-lock.js'

const root = () => mkdtempSync(join(tmpdir(), 'ac-vlock-'))
const lockPath = (r: string) => join(r, 'versions.lock')

describe('withVersionLock', () => {
  it('runs fn and releases the lock', async () => {
    const r = root()
    const result = await withVersionLock(r, 'test', () => 'done')
    expect(result).toBe('done')
    expect(existsSync(lockPath(r))).toBe(false)
  })

  it('holds the lock during fn and releases even if fn throws', async () => {
    const r = root()
    await expect(
      withVersionLock(r, 'test', () => {
        expect(existsSync(lockPath(r))).toBe(true)
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(existsSync(lockPath(r))).toBe(false)
  })

  it('serializes concurrent holders (wait) — no interleaving', async () => {
    const r = root()
    const order: string[] = []
    const one = withVersionLock(
      r,
      'a',
      async () => {
        order.push('a-start')
        await new Promise((res) => setTimeout(res, 60))
        order.push('a-end')
      },
      { wait: true }
    )
    const two = withVersionLock(
      r,
      'b',
      async () => {
        order.push('b-start')
        order.push('b-end')
      },
      { wait: true }
    )
    await Promise.all([one, two])
    // b must not start until a fully finished.
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('fails fast (no wait) when a LIVE process holds the lock', async () => {
    const r = root()
    // this process is alive → a lock naming our own pid is "live"
    writeFileSync(
      lockPath(r),
      JSON.stringify({ pid: process.pid, op: 'other', startedAt: new Date().toISOString(), procStart: '' })
    )
    await expect(withVersionLock(r, 'mine', () => 'x')).rejects.toThrow(/another version operation is in progress/)
  })

  it('preempts a stale lock whose holder PID is dead (ESRCH)', async () => {
    const r = root()
    // PID 2^31-1 is not a running process → ESRCH → dead → preemptible
    writeFileSync(
      lockPath(r),
      JSON.stringify({ pid: 2147483646, op: 'crashed', startedAt: new Date().toISOString(), procStart: 'x' })
    )
    const result = await withVersionLock(r, 'mine', () => 'reclaimed')
    expect(result).toBe('reclaimed')
    expect(existsSync(lockPath(r))).toBe(false)
    // the stale lock was moved aside for forensics
    expect(existsSync(`${lockPath(r)}.stale`)).toBe(true)
  })

  // No PID-reuse detection on Windows: `procStartTime` shells out to `ps`, which does not exist
  // there, so it returns '' and a live PID is never treated as reused.
  it.skipIf(process.platform === 'win32')(
    'preempts a live PID whose start time no longer matches (PID reuse)',
    async () => {
      const r = root()
      writeFileSync(
        lockPath(r),
        JSON.stringify({
          pid: process.pid,
          op: 'reused',
          startedAt: new Date().toISOString(),
          procStart: 'Sat Jan  1 00:00:00 1900' // cannot match this process's real start
        })
      )
      const result = await withVersionLock(r, 'mine', () => 'reclaimed')
      expect(result).toBe('reclaimed')
    }
  )

  it('preempts a corrupt lock file', async () => {
    const r = root()
    writeFileSync(lockPath(r), 'not json at all')
    const result = await withVersionLock(r, 'mine', () => 'ok')
    expect(result).toBe('ok')
  })

  it('does not delete a lock owned by another (live) pid on release', async () => {
    const r = root()
    // pre-place a live foreign holder, then a fail-fast attempt must leave it intact
    const foreign = JSON.stringify({
      pid: process.pid,
      op: 'foreign',
      startedAt: new Date().toISOString(),
      procStart: ''
    })
    writeFileSync(lockPath(r), foreign)
    await expect(withVersionLock(r, 'mine', () => 'x')).rejects.toThrow()
    expect(readFileSync(lockPath(r), 'utf8')).toBe(foreign)
  })
})
