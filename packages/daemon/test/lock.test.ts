import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSingletonLock, DaemonAlreadyRunningError } from '../src/lock.js'
import { lockPath } from '../src/paths.js'

describe('acquireSingletonLock', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ac-lock-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes our pid to <root>/daemon.lock when none exists', () => {
    const lock = acquireSingletonLock(root, { pid: 1234 })
    expect(readFileSync(lockPath(root), 'utf8').trim()).toBe('1234')
    lock.release()
  })

  it('creates the root directory and lock file when root does not exist', () => {
    const nonExistent = join(root, 'nested', 'dir')
    const lock = acquireSingletonLock(nonExistent, { pid: 5678 })
    expect(readFileSync(lockPath(nonExistent), 'utf8').trim()).toBe('5678')
    lock.release()
  })

  it('throws DaemonAlreadyRunningError when a live pid holds the lock', () => {
    // process.pid is alive by definition — use it as the "other" holder.
    writeFileSync(lockPath(root), `${process.pid}\n`, 'utf8')
    expect(() => acquireSingletonLock(root, { pid: process.pid + 1 })).toThrow(DaemonAlreadyRunningError)
  })

  it('reclaims a stale lock whose pid is dead', () => {
    // 2^31-ish pid that is virtually never alive.
    writeFileSync(lockPath(root), '2147480000\n', 'utf8')
    const lock = acquireSingletonLock(root, { pid: 4242 })
    expect(readFileSync(lockPath(root), 'utf8').trim()).toBe('4242')
    lock.release()
  })

  it('reclaims a garbage / unparseable lock file', () => {
    writeFileSync(lockPath(root), 'not-a-pid\n', 'utf8')
    const lock = acquireSingletonLock(root, { pid: 99 })
    expect(readFileSync(lockPath(root), 'utf8').trim()).toBe('99')
    lock.release()
  })

  it('re-acquiring with the same pid does not throw (idempotent for restarts)', () => {
    acquireSingletonLock(root, { pid: 555 }).release()
    expect(() => acquireSingletonLock(root, { pid: 555 })).not.toThrow()
  })

  it('release removes the file only when we still own it', () => {
    const lock = acquireSingletonLock(root, { pid: 777 })
    // someone else took over the lock after us
    writeFileSync(lockPath(root), '888\n', 'utf8')
    lock.release()
    expect(existsSync(lockPath(root))).toBe(true)
    expect(readFileSync(lockPath(root), 'utf8').trim()).toBe('888')
  })

  it('release is idempotent', () => {
    const lock = acquireSingletonLock(root, { pid: 321 })
    lock.release()
    expect(existsSync(lockPath(root))).toBe(false)
    expect(() => lock.release()).not.toThrow()
  })
})
