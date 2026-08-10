import { describe, expect, it, vi } from 'vitest'
import { feishuSdkLogger } from '../src/feishu/connection.js'

describe('Feishu SDK logger', () => {
  it('reports useful error codes without logging request credentials', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    feishuSdkLogger.error([
      'request failed',
      {
        config: { headers: { Authorization: 'Bearer tenant-secret' }, appSecret: 'app-secret' },
        response: { status: 429, data: { code: 99991400, msg: 'rate limited' } }
      }
    ])

    expect(output).toHaveBeenCalledWith('[agentconnect] ERROR feishu SDK error (http=429 code=99991400)')
    expect(output.mock.calls.flat().join(' ')).not.toMatch(/tenant-secret|app-secret|Authorization|Bearer/)
    output.mockRestore()
  })
})
