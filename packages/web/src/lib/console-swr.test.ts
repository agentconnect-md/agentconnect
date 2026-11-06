import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { readOnceRegistered } from './console-swr'

describe('readOnceRegistered', () => {
  it('reads a just-opened task again until its daemon has reported it', async () => {
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiError('session not found', 404))
      .mockRejectedValueOnce(new ApiError('session not found', 404))
      .mockResolvedValue('page')
    await expect(readOnceRegistered(read, [0, 0, 0])).resolves.toBe('page')
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('lets the not-found stand once its waits run out', async () => {
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(new ApiError('session not found', 404))
    await expect(readOnceRegistered(read, [0, 0])).rejects.toMatchObject({ status: 404 })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('leaves any other failure to the caller at once', async () => {
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(new ApiError('forbidden', 403))
    await expect(readOnceRegistered(read, [0, 0])).rejects.toMatchObject({ status: 403 })
    expect(read).toHaveBeenCalledTimes(1)
  })
})
