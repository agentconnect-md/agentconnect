import { describe, it, expect, vi } from 'vitest'
import { encodeFrame, decodeFrames, type IpcResponse } from '../src/mcp/ipc.js'

describe('decodeFrames', () => {
  it('round-trips encoded frames and keeps the trailing partial as rest', () => {
    const buf = encodeFrame({ id: 1, ok: true } as IpcResponse) + '{"id":2,"ok'
    const { messages, rest } = decodeFrames<IpcResponse>(buf)
    expect(messages).toEqual([{ id: 1, ok: true }])
    expect(rest).toBe('{"id":2,"ok')
  })

  it('skips a malformed line but keeps the good frames around it (no throw)', () => {
    const onError = vi.fn()
    const buf = '{"id":1,"ok":true}\nNOT JSON\n{"id":2,"ok":false}\n'
    const { messages, rest } = decodeFrames<IpcResponse>(buf, onError)
    expect(messages).toEqual([
      { id: 1, ok: true },
      { id: 2, ok: false }
    ])
    expect(rest).toBe('')
    expect(onError).toHaveBeenCalledOnce()
  })
})
