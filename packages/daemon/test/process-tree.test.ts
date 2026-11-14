import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { signalProcessTree, type ProcessTreeHost } from '../src/acp/process-tree.js'

const fakeChild = (over: Partial<ChildProcess> = {}): ChildProcess =>
  ({ pid: 4242, exitCode: null, signalCode: null, kill: vi.fn(() => true), ...over }) as unknown as ChildProcess

/** A Windows host whose `taskkill` is an emitter the test settles by hand. */
function windowsHost(env: NodeJS.ProcessEnv = { SystemRoot: 'D:\\Win' }) {
  const killer = new EventEmitter()
  const spawned = vi.fn((_file: string, _args: string[], _options: object) => killer)
  const host: ProcessTreeHost = { platform: 'win32', env, spawn: spawned as unknown as typeof spawn }
  return { host, killer, spawned }
}

describe('signalProcessTree on Windows', () => {
  it('walks the tree with the system taskkill instead of signalling the one pid', () => {
    const { host, killer, spawned } = windowsHost()
    const child = fakeChild()
    signalProcessTree(child, 'SIGTERM', host)
    expect(spawned).toHaveBeenCalledWith('D:\\Win\\System32\\taskkill.exe', ['/PID', '4242', '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    killer.emit('exit', 0)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('falls back to the direct child when taskkill fails or cannot run', () => {
    const failed = windowsHost({})
    const child = fakeChild()
    signalProcessTree(child, 'SIGKILL', failed.host)
    expect(failed.spawned.mock.calls[0]?.[0]).toBe('C:\\Windows\\System32\\taskkill.exe')
    failed.killer.emit('exit', 128)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')

    const missing = windowsHost()
    const other = fakeChild()
    signalProcessTree(other, 'SIGTERM', missing.host)
    missing.killer.emit('error', new Error('ENOENT'))
    expect(other.kill).toHaveBeenCalledWith('SIGTERM')

    const throwing = fakeChild()
    const spawnThrows = vi.fn(() => {
      throw new Error('EINVAL')
    })
    signalProcessTree(throwing, 'SIGTERM', { ...missing.host, spawn: spawnThrows as unknown as typeof spawn })
    expect(throwing.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('signals nothing for a child that never started or already exited', () => {
    const { host, spawned } = windowsHost()
    const unstarted = fakeChild({ pid: undefined })
    const exited = fakeChild({ exitCode: 0 })
    signalProcessTree(unstarted, 'SIGTERM', host)
    signalProcessTree(exited, 'SIGTERM', host)
    expect(spawned).not.toHaveBeenCalled()
    expect(unstarted.kill).not.toHaveBeenCalled()
    expect(exited.kill).not.toHaveBeenCalled()
  })

  it('leaves a child that exited while taskkill ran alone', () => {
    const { host, killer } = windowsHost()
    const state = { pid: 4242, exitCode: null as number | null, signalCode: null, kill: vi.fn(() => true) }
    signalProcessTree(state as unknown as ChildProcess, 'SIGTERM', host)
    state.exitCode = 1
    killer.emit('exit', 255)
    expect(state.kill).not.toHaveBeenCalled()
  })
})
