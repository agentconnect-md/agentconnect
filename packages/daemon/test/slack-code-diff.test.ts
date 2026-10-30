import { afterEach, describe, expect, it, vi } from 'vitest'
import { startCodeDiff, type CodeDiffHost } from '../src/platforms/slack/code-diff.js'
import { TaskDiffIneligible } from '../src/workspace/task-diff.js'

afterEach(() => vi.useRealTimers())

function setup() {
  let content = ''
  let active = true
  const read = vi.fn(async () => content)
  const host: CodeDiffHost = {
    authorize: vi.fn(async () => {}),
    open: vi.fn(async () => ({ read })),
    active: () => active,
    mask: (text) => text.replaceAll('secret', '[redacted]'),
    publish: vi.fn(async () => {}),
    notice: vi.fn(async () => {}),
    debug: vi.fn()
  }
  return {
    host,
    read,
    change: (text: string) => {
      content = text
    },
    suppress: () => {
      active = false
    }
  }
}

describe('Slack task diff publisher', () => {
  it('quietly leaves ineligible sessions on their existing output path across turns', async () => {
    const { host } = setup()
    vi.mocked(host.open).mockRejectedValue(new TaskDiffIneligible('No saved baseline'))
    expect(await startCodeDiff(host)).toBeUndefined()
    expect(await startCodeDiff(host)).toBeUndefined()
    expect(host.notice).not.toHaveBeenCalled()
    expect(host.publish).not.toHaveBeenCalled()
    expect(host.debug).toHaveBeenCalledTimes(2)
  })

  it('coalesces changes, masks content, reauthorizes publications and flushes the final state', async () => {
    vi.useFakeTimers()
    const { host, change } = setup()
    const output = await startCodeDiff(host)
    change('one')
    change('two secret')
    await vi.advanceTimersByTimeAsync(5000)
    expect(host.publish).toHaveBeenCalledExactlyOnceWith('two [redacted]', expect.any(AbortSignal))
    await vi.advanceTimersByTimeAsync(5000)
    expect(host.publish).toHaveBeenCalledTimes(1)
    change('three')
    await output!.settle()
    expect(host.publish).toHaveBeenLastCalledWith('three', expect.any(AbortSignal))
    expect(host.authorize).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('publishes an empty state when all task changes are reverted', async () => {
    vi.useFakeTimers()
    const { host, change } = setup()
    const output = await startCodeDiff(host)
    change('patch')
    await vi.advanceTimersByTimeAsync(5000)
    change('')
    await output!.settle()
    expect(host.publish).toHaveBeenLastCalledWith('', expect.any(AbortSignal))
  })

  it('clears an earlier view after resuming a task whose changes were reverted', async () => {
    const { host } = setup()
    const output = await startCodeDiff({ ...host, hasPublished: true })
    await output!.settle()
    expect(host.publish).toHaveBeenCalledExactlyOnceWith('', expect.any(AbortSignal))
  })

  it('stops after rejection and never retries the rejected publication', async () => {
    vi.useFakeTimers()
    const { host, change } = setup()
    const output = await startCodeDiff(host)
    vi.mocked(host.authorize).mockRejectedValue(new Error('denied'))
    change('patch')
    await vi.advanceTimersByTimeAsync(20_000)
    await output!.settle()
    expect(host.publish).not.toHaveBeenCalled()
    expect(host.notice).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not even open the workspace without authorization', async () => {
    const { host } = setup()
    vi.mocked(host.authorize).mockRejectedValue(new Error('denied'))
    expect(await startCodeDiff(host)).toBeUndefined()
    expect(host.open).not.toHaveBeenCalled()
  })

  it('drops an in-flight read on Stop and drains it before releasing the turn', async () => {
    vi.useFakeTimers()
    const { host, read } = setup()
    let resolve!: (value: string) => void
    read.mockImplementation(
      () =>
        new Promise<string>((done) => {
          resolve = done
        })
    )
    const output = await startCodeDiff(host)
    vi.advanceTimersByTime(5000)
    output!.stop()
    resolve('late patch')
    await output!.settle()
    expect(host.publish).not.toHaveBeenCalled()
    expect(host.notice).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
