import { describe, expect, it, vi } from 'vitest'
import { observeStartup, withStartupPhase, shareStartup, awaitStartup } from '../src/session/startup-progress.js'
import { StartupNotice } from '../src/platforms/startup-notice.js'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('startup progress lifetime', () => {
  it('keeps the failed nested phase and propagates the startup error', async () => {
    const report = vi.fn()
    const operation = shareStartup(() =>
      withStartupPhase('sandbox', async () => {
        throw new Error('sandbox failed')
      })
    )
    await expect(
      observeStartup(report, () => withStartupPhase('workspace', () => awaitStartup(operation)))
    ).rejects.toThrow('sandbox failed')
    expect(report).toHaveBeenLastCalledWith('sandbox')
  })

  it('keeps a shared start visible to its later waiter after the first turn leaves', async () => {
    const workspace = deferred()
    const cancelled = deferred()
    const first = vi.fn()
    const second = vi.fn()
    const operation = shareStartup(() =>
      withStartupPhase('workspace', async () => {
        await workspace.promise
        await withStartupPhase('runtime', async () => {})
      })
    )
    const a = observeStartup(first, () => Promise.race([awaitStartup(operation), cancelled.promise]))
    const b = observeStartup(second, () => awaitStartup(operation))
    expect(first).toHaveBeenCalledWith('workspace')
    expect(second).toHaveBeenCalledWith('workspace')
    cancelled.resolve()
    await a
    first.mockClear()
    workspace.resolve()
    await b
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('runtime')
  })

  it('stops queued edits on cancellation and retains a post already sent', async () => {
    const posted = deferred<string>()
    const conn = {
      postMessage: vi.fn(() => posted.promise),
      updateMessage: vi.fn(async () => {}),
      deleteMessage: vi.fn(async () => true)
    }
    const notice = new StartupNotice(conn, 'channel', 'thread', (error) => {
      throw error
    })
    notice.update('Preparing workspace…')
    await Promise.resolve()
    expect(conn.postMessage).toHaveBeenCalledOnce()
    notice.update('Starting agent…')
    const closed = notice.close()
    notice.update('late update')
    posted.resolve('notice-id')
    await closed
    expect(conn.deleteMessage).not.toHaveBeenCalled()
    expect(conn.updateMessage).not.toHaveBeenCalled()
  })
})
