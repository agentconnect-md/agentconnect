import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPathSync, PATH_SYNC_MS, readShimMessage, readViewerPath } from './viewer-path'

describe('readShimMessage', () => {
  it('takes the shim message shapes', () => {
    expect(readShimMessage({ t: 'ready', extra: 1 })).toEqual({ t: 'ready' })
    expect(readShimMessage({ t: 'need-port' })).toEqual({ t: 'need-port' })
    expect(readShimMessage({ t: 'path', path: '/a' })).toEqual({ t: 'path', path: '/a' })
    expect(readShimMessage({ t: 'unsupported', reason: 'no-service-worker' })).toEqual({
      t: 'unsupported',
      reason: 'no-service-worker'
    })
  })

  it.each([null, 'ready', { t: 'port' }, { t: 'path', path: 1 }, { t: 'unsupported', reason: 'other' }])(
    'refuses %j',
    (data) => expect(readShimMessage(data)).toBeNull()
  )
})

describe('readViewerPath', () => {
  it.each([
    ['/docs/about.html', '/docs/about.html'],
    ['/app/settings?tab=2#top', '/app/settings?tab=2#top'],
    ['/a/../b.html', '/b.html'],
    ['/caf%C3%A9.html', '/caf%C3%A9.html']
  ])('keeps %j as %j', (value, path) => expect(readViewerPath(value)).toBe(path))

  it.each([
    null,
    7,
    '',
    'docs/about.html',
    '//evil.example.test/x',
    'https://evil.example.test/',
    'javascript:alert(1)',
    '/__ac/shim',
    '/__ac/sw.js',
    '/x/../__ac/shim',
    '/a\\b',
    '/a\nb',
    `/${'a'.repeat(2048)}`
  ])('refuses %j', (value) => expect(readViewerPath(value)).toBeNull())
})

describe('createPathSync', () => {
  afterEach(() => vi.useRealTimers())

  it('writes the latest path once per window and skips an unchanged one', () => {
    vi.useFakeTimers()
    const write = vi.fn()
    const sync = createPathSync(write, null)
    for (let i = 0; i < 50; i++) sync.push(`/page-${i}`)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(PATH_SYNC_MS)
    expect(write.mock.calls).toEqual([['/page-49']])
    sync.push('/page-49')
    vi.advanceTimersByTime(PATH_SYNC_MS)
    expect(write).toHaveBeenCalledTimes(1)
    sync.push('/page-1')
    sync.push(null)
    vi.advanceTimersByTime(PATH_SYNC_MS)
    expect(write.mock.calls.at(-1)).toEqual([null])
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('writes nothing after cancel', () => {
    vi.useFakeTimers()
    const write = vi.fn()
    const sync = createPathSync(write, '/a')
    sync.push('/b')
    sync.cancel()
    vi.advanceTimersByTime(PATH_SYNC_MS * 2)
    expect(write).not.toHaveBeenCalled()
  })
})
